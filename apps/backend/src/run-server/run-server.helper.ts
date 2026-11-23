import type { AddressInfo } from 'node:net';
import { PROTOCOL_VERSION } from '@sheavly/protocol/version/protocol-version.constants';
import type { Environment } from '@sheavly/core/environment/environment.types';
import { sheavlyHome } from '@sheavly/storage/home/home.helper';
import type { ServerPresence } from '@sheavly/storage/discovery-file/server-presence.service';
import { pruneScratch } from '@sheavly/workspace/scratch/scratch.helper';
import { claimServerPresence } from '../discovery/claim-presence.helper.js';
import { discoveryFileFor, isDiscoverable } from '../discovery/discovery.utils.js';
import type { StartupGuard } from '../discovery/discovery.types.js';
import { guardStartup } from '../discovery/startup-signals.helper.js';
import type { ServedSettings } from '../harness/harness.types.js';
import { sharedScratchRoot } from '../harness/scratch.helper.js';
import { parseCliSettings, parseRunEnv, parseServerEnv } from '../harness/settings.validator.js';
import { listenServer } from '../listen/listen.helper.js';
import { buildServer } from './build-server.helper.js';
import { printStarted } from './print-started.helper.js';
import type { BuiltServer, RunServerParams, ServerSettings } from './run-server.types.js';
import { stopOnSignals, stopWhenParentGone } from './stop-server.helper.js';

/**
 * Takes the one-server lock, or exits 1 when another server holds it, after the guard has said
 * the start may go on. Returns the presence it holds: undefined when this server is not
 * discoverable or the lock was unavailable.
 */
async function claimOrRefuse(params: {
  env: Environment;
  server: ServerSettings;
  settings: ServedSettings;
  guard: StartupGuard;
  log: (text: string) => void;
  exit: (code: number) => never;
}): Promise<ServerPresence | undefined> {
  const { env, server, settings, guard, log, exit } = params;
  // The first thing the start takes: a refused start has changed nothing but its own lock probe.
  const claiming = claimServerPresence({
    discoverable: isDiscoverable({ ...server, ...settings }),
    home: sheavlyHome(env),
    env,
    uid: process.getuid?.() ?? 0,
    log,
  });

  guard.track(claiming.then((claimed) => (claimed.status === 'go' ? claimed.presence : undefined)));

  const start = await claiming;

  // After a signal the guard cleans up and exits; the start does nothing more, not even refuse.
  await guard.proceed();

  if (start.status === 'refused') {
    log(`${start.message}\n`);

    return exit(1);
  }

  return start.presence;
}

/** Listens; a failure releases the lock first and is thrown as the error it is. */
async function listenOrRelease(params: {
  built: BuiltServer;
  server: ServerSettings;
  presence: ServerPresence | undefined;
}): Promise<AddressInfo> {
  const { built, server, presence } = params;

  try {
    await listenServer({
      server: built.listening,
      host: server.host,
      port: server.port,
      fallback: server.portIsDefault,
    });
  } catch (caughtError) {
    // The failure is the same error as without a lock, and no socket is left behind.
    await presence?.release();
    throw caughtError;
  }

  // A TCP listen (host and port) always has an address object, never a pipe path.
  return built.listening.address() as AddressInfo;
}

/** Writes the discovery file and waits for it, with the guard told what a signal must wait for. */
async function publishDiscovery(params: {
  built: BuiltServer;
  server: ServerSettings;
  presence: ServerPresence | undefined;
  address: AddressInfo;
  guard: StartupGuard;
}): Promise<void> {
  const { built, server, presence, address, guard } = params;
  const publishing = presence?.publish(
    discoveryFileFor({
      ...server,
      port: address.port,
      token: built.token,
      instanceId: built.instanceId,
      serverVersion: built.serverVersion,
      protocolVersion: PROTOCOL_VERSION,
      pid: process.pid,
    }),
  );

  // A signal now must wait for the write, or the file would appear after it was removed.
  guard.track(Promise.resolve(publishing).then(() => presence));
  await publishing;
}

/**
 * Runs the harness backend in this process: reads its settings from `env` and `args` (the
 * process's own by default), takes the lock, listens, publishes the discovery file and prints
 * the `→ listening on <url>` line. It resolves once the server listens and keeps the process
 * alive; a signal or, with SERVER_EXIT_WITH_PARENT, a closed stdin stops it and calls `exit`.
 * Throws a settings or build error before anything is taken, and the listen error after the lock
 * is released. The order of the steps is the contract: a signal at any point must leave nothing
 * behind.
 */
export async function runServer(params: RunServerParams = {}): Promise<void> {
  const {
    env = process.env,
    args = process.argv.slice(2),
    exit = (code) => process.exit(code),
  } = params;

  // npm runs a workspace's script inside its folder; work from the folder it was started in
  // (npm's INIT_CWD), so the default workspace is the user's.
  if (env.INIT_CWD) process.chdir(env.INIT_CWD);

  const settings = { ...parseCliSettings({ env, args }), ...parseRunEnv(env) };
  const server = parseServerEnv(env);
  const log = (text: string) => void process.stderr.write(text);

  // Before the lock and the file exist: a signal while starting must not leave them behind.
  const guard = guardStartup({ source: process, exit, log });
  const built = await buildServer({ env, settings, server, log });
  const presence = await claimOrRefuse({ env, server, settings, guard, log, exit });

  // Stale scratch entries are removed once at startup; a failure is reported, never fatal.
  pruneScratch({ root: sharedScratchRoot() }).catch((caughtError: unknown) =>
    log(`Could not prune the scratch folder: ${String(caughtError)}\n`),
  );

  const address = await listenOrRelease({ built, server, presence });

  await guard.proceed();
  // Before the `listening` line, so a client that waited for it finds the file.
  await publishDiscovery({ built, server, presence, address, guard });
  await guard.proceed();

  const stop = stopOnSignals({ built, presence, exit });

  // After the stop handlers and before the `listening` line: with no listener for a moment, Node
  // restores the default action, and a UI that signals on that line would kill the process.
  guard.uninstall();
  printStarted({
    env,
    server,
    token: built.token,
    address,
    toTerminal: process.stdout.isTTY,
  });

  if (settings.exitWithParent) stopWhenParentGone(stop);
}

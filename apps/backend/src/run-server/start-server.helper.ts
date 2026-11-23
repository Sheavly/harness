import type { AddressInfo } from 'node:net';
import { PROTOCOL_VERSION } from '@sheavly/protocol/version/protocol-version.constants';
import type { Environment } from '@sheavly/core/environment/environment.types';
import { sheavlyHome } from '@sheavly/storage/home/home.helper';
import type { ServerPresence } from '@sheavly/storage/discovery-file/server-presence.service';
import { pruneScratch } from '@sheavly/workspace/scratch/scratch.helper';
import { claimServerPresence } from '../discovery/claim-presence.helper.js';
import { discoveryFileFor, isDiscoverable } from '../discovery/discovery.utils.js';
import type { PresenceStart, StartupGuard } from '../discovery/discovery.types.js';
import type { ServedSettings } from '../harness/harness.types.js';
import { sharedScratchRoot } from '../harness/scratch.helper.js';
import { listenServer } from '../listen/listen.helper.js';
import { LOG_EVENT } from '../logging/logging.constants.js';
import { buildServer } from './build-server.helper.js';
import type { BuiltServer, ServerSettings, StartOutcome } from './run-server.types.js';

/**
 * Takes the lock once the guard has said the start may go on. Returns what the claim found:
 * `go` with the presence it holds (undefined when this server is not discoverable or the lock was
 * unavailable, already warned about), or `refused` because another server holds it.
 */
async function claim(params: {
  env: Environment;
  server: ServerSettings;
  settings: ServedSettings;
  guard: StartupGuard;
  log: (text: string) => void;
}): Promise<PresenceStart> {
  const { env, server, settings, guard, log } = params;
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

  return start;
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
 * Starts the server in this process, from settings already parsed: builds it, takes the lock,
 * listens and publishes the discovery file, and hands back what is running. It installs no signal
 * handler of its own, prints nothing and never exits: a refused start is returned, a failing
 * build or listen throws (the lock released first), and the caller decides how the process ends
 * and what it says. The `guard` (`guardStartup`) must already be installed: it is how a signal
 * during the start leaves nothing behind. The order of the steps is the contract: the backend is
 * built (every setting error comes here) before the lock is claimed, and the lock before anything
 * listens or is written.
 */
export async function startServer(params: {
  env: Environment;
  settings: ServedSettings;
  server: ServerSettings;
  log: (text: string) => void;
  guard: StartupGuard;
}): Promise<StartOutcome> {
  const { env, settings, server, log, guard } = params;
  const built = await buildServer({ env, settings, server, log });
  const claimed = await claim({ env, server, settings, guard, log });

  if (claimed.status === 'refused') {
    // A caller that goes on living (it was only asked to start one) must not keep a built backend.
    // A failure to close it is told, but never replaces the refusal the caller needs.
    await built.conversations.closeAll().catch((caughtError: unknown) => {
      log(`A refused start could not close the backend it built: ${String(caughtError)}\n`);
    });

    return { status: 'refused', message: claimed.message };
  }

  const { presence } = claimed;

  // Stale scratch entries are removed once at startup; a failure is reported, never fatal.
  pruneScratch({ root: sharedScratchRoot() }).catch((caughtError: unknown) =>
    built.logs.server.warn(LOG_EVENT.SCRATCH_PRUNE_FAILED, { error: caughtError }),
  );

  const address = await listenOrRelease({ built, server, presence });

  await guard.proceed();
  // Before the caller says it listens, so a client that waited for that finds the file.
  await publishDiscovery({ built, server, presence, address, guard });
  await guard.proceed();

  return { status: 'started', built, presence, address };
}

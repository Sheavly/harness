import type { Environment } from '@sheavly/core/environment/environment.types';
import { LOOPBACK_HOST } from '../discovery/discovery.constants.js';
import { publishedUrl } from '../discovery/discovery.utils.js';
import { guardStartup } from '../discovery/startup-signals.helper.js';
import { parseCliSettings, parseRunEnv, parseServerEnv } from '../harness/settings.validator.js';
import type { EmbeddedStart } from './run-server.types.js';
import { startServer } from './start-server.helper.js';
import { closeServer, handleStopSignals } from './stop-server.helper.js';

/**
 * The environment this server's own settings are read from: the caller's, with what decides where
 * and how a server is exposed replaced. An embedded server listens on loopback only, on a port
 * the OS picks, with a token of its own (the caller's `SERVER_TOKEN` is never reused), is always
 * findable and takes the lock, and does not stop with a parent's stdin. A model key that crosses
 * to it must never cross a network or reach a server someone else chose.
 */
function ownServerEnv(env: Environment): Environment {
  return {
    ...env,
    SERVER_HOST: LOOPBACK_HOST,
    SERVER_PORT: '0',
    SERVER_TOKEN: undefined,
    SERVER_DISCOVERY: 'true',
    SERVER_ALLOW_REMOTE_SETUP: undefined,
    SERVER_EXIT_WITH_PARENT: undefined,
  };
}

/**
 * Starts a server in this process for a command that needs one for a while and then goes on
 * living: it listens on loopback, takes the home's one-server lock and publishes its discovery
 * file, so the finder reads and verifies it like any other server and the caller never receives
 * its token from here: it is not returned, printed or stored by this function. It prints nothing
 * (the caller owns the terminal), takes `log` for what a server logs, and does not touch the
 * process's end: `close` takes it down (out of the file, stop listening, close every
 * conversation, release the lock, even when a conversation fails to close) and then takes its
 * signal handlers off, so a process with nothing else to do ends by itself. A SIGINT, SIGTERM or
 * SIGHUP before that, or during the close, waits for it and then calls `exit` with the usual
 * code; a second one calls `exit` at once. `started` carries the `url` it listens at (never a token), so a
 * caller that then finds a server can check it found this one. Returns `refused` when another
 * server holds the lock (or is starting), having changed nothing; throws a settings or build
 * error, or the listen error, with the lock released and every handler off.
 */
export async function startEmbeddedServer(params: {
  env?: Environment;
  log: (text: string) => void;
  exit?: (code: number) => never;
}): Promise<EmbeddedStart> {
  const { env = process.env, log, exit = (code) => process.exit(code) } = params;
  const own = ownServerEnv(env);
  const settings = { ...parseCliSettings({ env, args: [] }), ...parseRunEnv(own) };
  const server = parseServerEnv(own);
  const guard = guardStartup({ source: process, exit, log });
  const started = await startServer({ env, settings, server, log, guard }).catch(
    (caughtError: unknown) => {
      guard.uninstall();
      throw caughtError;
    },
  );

  if (started.status === 'refused') {
    guard.uninstall();

    return started;
  }

  const { built, presence, address } = started;
  let closing: Promise<void> | undefined;

  // The handlers stay on until the server is down: a signal during a slow close must wait for it
  // and then exit, not meet Node's default action and skip the rest of the close.
  function close(): Promise<void> {
    closing ??= closeServer({ built, presence }).finally(detach);

    return closing;
  }

  let signalled = false;

  // Before the guard comes off, so no moment is left where a signal finds neither. The first
  // signal closes and then exits; a second one, as with the startup guard and `runServer`'s stop,
  // exits at once, so a close that hangs can still be ended without SIGKILL.
  const detach = handleStopSignals((code) => {
    if (signalled) {
      exit(code);

      return;
    }

    signalled = true;
    void close()
      .catch((caughtError: unknown) => {
        log(`The server did not stop cleanly: ${String(caughtError)}\n`);
      })
      .finally(() => exit(code));
  });

  guard.uninstall();

  return {
    status: 'started',
    url: publishedUrl({ host: LOOPBACK_HOST, port: address.port }),
    close,
  };
}

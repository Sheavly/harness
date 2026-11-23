import type { ChatServer } from '../chat/chat.types.js';
import { NoServerError, ServerNotRunningError } from '../errors/cli.errors.js';
import { LOCK_HELD_HINT, LOGGED_WHILE_STARTING, STARTED_UNUSABLE } from './setup.constants.js';
import type { ServerForSetup, StartPrivateServer } from './setup.types.js';

/** What the server logged while it started, as text to add to a failure, or nothing. */
function logged(logs: readonly string[]): string {
  const text = logs.join('').trim();

  return text === '' ? '' : `\n${LOGGED_WHILE_STARTING}\n${text}`;
}

/** What went wrong with `caughtError`, in words that never hold a token. */
function reasonOf(caughtError: unknown): string {
  return caughtError instanceof Error ? caughtError.message : STARTED_UNUSABLE.unknown;
}

/**
 * The failure of stopping the server, as text to add to the one being reported, or nothing. A
 * server that cannot be stopped cleanly must not replace the reason the setup could not go on.
 */
async function stopFailure(close: () => Promise<void>): Promise<string> {
  return close().then(
    () => '',
    (caughtError: unknown) =>
      `\n${STARTED_UNUSABLE.stopFailed} ${caughtError instanceof Error ? caughtError.message : STARTED_UNUSABLE.stopUnknown}`,
  );
}

/**
 * The server `sheavly setup` runs on: the running one `findServer` finds and verifies; or, when
 * there is none at all (`ServerNotRunningError`) and there is a terminal to ask in, a short-lived
 * one this process starts with `startServer`. That one is looked up again with the same lookup,
 * so the key goes only to a server that proved it holds the token, and only when the lookup
 * found the address this process started: any other server the lookup could return, found after
 * the start, is not used. Any other failure of the first lookup (a server of another protocol),
 * and no server without a terminal, is thrown as it is, with nothing started. A refused start
 * (another server holds the home's lock) and a started server the lookup cannot use, or finds
 * elsewhere, are `NoServerError`s that say so, and the server is stopped first. The messages never
 * hold the token. `close` is set exactly when this started the server.
 */
export async function serverForSetup(params: {
  env: NodeJS.ProcessEnv;
  findServer: (env: NodeJS.ProcessEnv) => Promise<ChatServer>;
  startServer: StartPrivateServer;
  interactive: boolean;
}): Promise<ServerForSetup> {
  const { env, findServer, startServer, interactive } = params;
  const found = await findServer(env).then(
    (server): ServerForSetup => ({ server }),
    (caughtError: unknown) => {
      // Only "nothing runs" starts one, and only where setup can ask its questions after.
      if (caughtError instanceof ServerNotRunningError && interactive) return undefined;

      throw caughtError;
    },
  );

  if (found) return found;

  const logs: string[] = [];
  let starting = true;
  const started = await startServer({
    env,
    // Only what it logs while it starts is kept: the server runs for minutes, and the rest is not
    // shown anywhere.
    log: (text) => {
      if (starting) logs.push(text);
    },
  });

  starting = false;

  if (started.status === 'refused') {
    throw new NoServerError(`${started.message}\n${LOCK_HELD_HINT}${logged(logs)}`);
  }

  const unusable = async (why: string): Promise<never> => {
    const stopped = await stopFailure(started.close);

    throw new NoServerError(`${STARTED_UNUSABLE.lead}\n${why}${stopped}${logged(logs)}`);
  };
  const server = await findServer(env).catch((caughtError: unknown) =>
    unusable(reasonOf(caughtError)),
  );

  if (server.url !== started.url) return unusable(STARTED_UNUSABLE.elsewhere);

  return { server, close: started.close };
}

/**
 * Runs `run` and then, whatever it did, `close` (the server setup started, when it did): the one
 * error that is thrown is `run`'s, else `close`'s, so a server that fails to stop never turns a
 * cancelled setup into another failure, nor a saved one into a success line followed by an error.
 * A failure to stop after a failed run is not reported: the run's is the one that matters.
 */
export async function runThenClose(params: {
  run: () => Promise<void>;
  close?: () => Promise<void>;
}): Promise<void> {
  const { run, close } = params;
  // Through a promise, so a `run` that throws before it returns one still reaches the close.
  const ran = await Promise.resolve()
    .then(run)
    .then(
      () => undefined,
      (caughtError: unknown) => ({ caughtError }),
    );
  const closed = await close?.().then(
    () => undefined,
    (caughtError: unknown) => ({ caughtError }),
  );

  if (ran) throw ran.caughtError;

  if (closed) throw closed.caughtError;
}

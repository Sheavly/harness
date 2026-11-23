import type { ServerPresence } from '@sheavly/storage/discovery-file/server-presence.service';
import { STOP_SIGNALS } from '../discovery/discovery.constants.js';
import type { BuiltServer } from './run-server.types.js';

/**
 * Takes a running server down: stops taking requests, then closes every conversation (its
 * prompts, tasks and processes). Out of the file first, so clients stop finding it; the lock last,
 * so a successor cannot start while conversations are still closing.
 */
async function closeServer(params: {
  built: BuiltServer;
  presence: ServerPresence | undefined;
}): Promise<void> {
  const { built, presence } = params;

  await presence?.remove();
  built.listening.close();
  await built.conversations.closeAll();
  await presence?.release();
}

/**
 * Calls `stop` with the usual exit code on SIGINT, SIGTERM and SIGHUP, now, and returns the
 * function that takes those handlers off again. Install it before the startup guard takes its own
 * off, so no moment is left with none: Node's default action would end the process with the
 * file and the lock left behind.
 */
function handleStopSignals(stop: (code: number) => void): () => void {
  const listeners = STOP_SIGNALS.map(({ signal, code }) => ({
    signal,
    listener: () => {
      stop(code);
    },
  }));

  for (const { signal, listener } of listeners) process.on(signal, listener);

  return () => {
    for (const { signal, listener } of listeners) process.off(signal, listener);
  };
}

/**
 * Makes the running server stop on SIGINT, SIGTERM and SIGHUP, and returns the stop for a caller
 * that ends it another way. Installs the handlers now, so call it before the startup guard
 * takes its own off. `say` is told `→ stopped` once the server is down (the console's, unless a
 * caller that owns the terminal passes another).
 */
export function stopOnSignals(params: {
  built: BuiltServer;
  presence: ServerPresence | undefined;
  exit: (code: number) => never;
  say?: (text: string) => void;
}): (code: number) => Promise<never> {
  const {
    built,
    presence,
    exit,
    say = (text) => {
      console.log(text);
    },
  } = params;
  let stopping = false;

  async function stop(code: number): Promise<never> {
    if (stopping) return exit(code);

    stopping = true;
    await closeServer({ built, presence });
    say('→ stopped');

    return exit(code);
  }

  handleStopSignals((code) => void stop(code));

  return stop;
}

/**
 * A UI that started the backend holds its stdin open; when the UI exits, even killed, the pipe
 * closes, so nothing it started outlives it.
 */
export function stopWhenParentGone(stop: (code: number) => Promise<never>): void {
  process.stdin.resume();
  process.stdin.once('end', () => void stop(0));
}

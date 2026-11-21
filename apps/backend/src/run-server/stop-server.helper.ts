import type { ServerPresence } from '@sheavly/storage/discovery-file/server-presence.service';
import { STOP_SIGNALS } from '../discovery/discovery.constants.js';
import type { BuiltServer } from './run-server.types.js';

/**
 * Makes the running server stop on SIGINT, SIGTERM and SIGHUP, and returns the stop for a caller
 * that ends it another way. Installs the handlers now, so call it before the startup guard
 * takes its own off.
 */
export function stopOnSignals(params: {
  built: BuiltServer;
  presence: ServerPresence | undefined;
  exit: (code: number) => never;
}): (code: number) => Promise<never> {
  const { built, presence, exit } = params;
  let stopping = false;

  /** Stops taking requests, then closes every conversation: its prompts, tasks and processes. */
  async function stop(code: number): Promise<never> {
    if (stopping) return exit(code);

    stopping = true;
    // Out of the file first, so clients stop finding it; the lock last, so a successor cannot start
    // while conversations are still closing.
    await presence?.remove();
    built.listening.close();
    await built.conversations.closeAll();
    await presence?.release();
    console.log('→ stopped');

    return exit(code);
  }

  for (const { signal, code } of STOP_SIGNALS) process.on(signal, () => void stop(code));

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

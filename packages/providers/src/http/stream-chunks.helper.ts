import { ConnectionLostError } from '@sheavly/core/errors/connection.errors';
import { describeWait } from './outage.utils.js';
import { networkMessage } from './network-message.utils.js';

/** The next chunk of `iterator`, or a `ConnectionLostError` when none arrives within `idleMs`. */
async function nextWithin(params: {
  iterator: AsyncIterator<Uint8Array>;
  idleMs: number;
}): Promise<IteratorResult<Uint8Array>> {
  const { iterator, idleMs } = params;
  let timer: NodeJS.Timeout | undefined;
  const silent = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      reject(
        new ConnectionLostError({
          reason: 'idle',
          message: `The reply went silent for ${describeWait(idleMs)}: the connection to the provider is gone`,
        }),
      );
    }, idleMs);
  });

  try {
    return await Promise.race([iterator.next(), silent]);
  } finally {
    clearTimeout(timer);
  }
}

/** One chunk, with a failed read turned into the loss of the connection. */
async function nextChunk(params: {
  iterator: AsyncIterator<Uint8Array>;
  idleMs: number;
  signal: AbortSignal;
}): Promise<IteratorResult<Uint8Array>> {
  const { iterator, idleMs, signal } = params;

  try {
    return await nextWithin({ iterator, idleMs });
  } catch (caughtError) {
    if (signal.aborted || caughtError instanceof ConnectionLostError) throw caughtError;

    throw new ConnectionLostError({
      reason: 'dropped',
      message: `The connection to the provider was lost while the reply streamed: ${networkMessage(caughtError)}`,
      cause: caughtError,
    });
  }
}

/**
 * The chunks of a reply's body, until it ends. A read that fails, or a body that sends nothing
 * for `idleMs`, is a `ConnectionLostError` (a connection that died without saying so, as one does
 * when a computer sleeps, would otherwise hold the run for ever). The caller's interrupt, `signal`,
 * is not one: it goes up as it came.
 */
export async function* streamChunks(params: {
  body: AsyncIterable<Uint8Array>;
  idleMs: number;
  signal: AbortSignal;
}): AsyncGenerator<Uint8Array> {
  const { body, idleMs, signal } = params;
  // Driven by hand: `for await` has no way to give up on a read that never comes.
  const iterator = body[Symbol.asyncIterator]();

  try {
    for (;;) {
      const chunk = await nextChunk({ iterator, idleMs, signal });

      if (chunk.done) return;

      yield chunk.value;
    }
  } finally {
    // A silent body is still open: stop reading it. Nothing waits for that to finish.
    void iterator.return?.();
  }
}

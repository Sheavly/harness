import { ConnectionLostError } from '@sheavly/core/errors/connection.errors';
import { describeWait } from './outage.utils.js';
import { networkMessage } from './network-message.utils.js';

type Reader = ReadableStreamDefaultReader<Uint8Array>;
type Chunk = Awaited<ReturnType<Reader['read']>>;

/**
 * The next chunk of `reader`, or a `ConnectionLostError` when none arrives within `idleMs`, or the
 * signal's reason when `signal` aborts first (a body that ignores the signal would otherwise hold
 * the interrupt until the idle timer).
 */
async function nextWithin(params: {
  reader: Reader;
  idleMs: number;
  signal: AbortSignal;
}): Promise<Chunk> {
  const { reader, idleMs, signal } = params;
  let timer: NodeJS.Timeout | undefined;
  let onAbort: (() => void) | undefined;
  const aborted = new Promise<void>((resolve) => {
    onAbort = () => {
      resolve();
    };

    if (signal.aborted) resolve();
    else signal.addEventListener('abort', onAbort, { once: true });
  });
  // Rejects with the signal's own reason, as `throwIfAborted` throws it, so an interrupt goes up
  // as the caller wrote it. Never settles while the signal has not aborted.
  const interrupted = aborted.then((): never => {
    signal.throwIfAborted();

    throw new ConnectionLostError({ reason: 'dropped', message: 'The interrupt was lost' });
  });
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
    return await Promise.race([reader.read(), silent, interrupted]);
  } finally {
    clearTimeout(timer);
    if (onAbort) signal.removeEventListener('abort', onAbort);
  }
}

/**
 * Cancelling a body that is already closed or broken can reject with its own error, which says
 * nothing new: the read that failed has been reported. Anything that is not an error is not that.
 */
function ignoreCancelFailure(caughtError: unknown): void {
  if (!(caughtError instanceof Error)) throw caughtError;
}

/** One chunk, with a failed read turned into the loss of the connection. */
async function nextChunk(params: {
  reader: Reader;
  idleMs: number;
  signal: AbortSignal;
}): Promise<Chunk> {
  const { reader, idleMs, signal } = params;

  try {
    return await nextWithin({ reader, idleMs, signal });
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
 * is not one: it goes up as it came. However it ends, the body is cancelled, so a connection that
 * went silent does not keep its socket and its pending read.
 */
export async function* streamChunks(params: {
  body: ReadableStream<Uint8Array>;
  idleMs: number;
  signal: AbortSignal;
}): AsyncGenerator<Uint8Array> {
  const { body, idleMs, signal } = params;
  // A reader, not `for await`: only a reader can give up on a read that never comes, and cancel
  // the body under it (an async iterator's `return()` waits for the pending read).
  const reader = body.getReader();
  let open = true;

  try {
    for (;;) {
      const chunk = await nextChunk({ reader, idleMs, signal });

      if (chunk.done) {
        open = false;

        return;
      }

      yield chunk.value;
    }
  } catch (caughtError) {
    // A body that ended or failed is closed already, and cancelling it would only throw its error
    // a second time. One that went silent is still open, as is one the caller interrupted.
    open =
      signal.aborted ||
      (caughtError instanceof ConnectionLostError && caughtError.reason === 'idle');

    throw caughtError;
  } finally {
    // Not awaited: a cancel that never settles must not hold a run that already knows its answer.
    if (open) void reader.cancel().catch(ignoreCancelFailure);
  }
}

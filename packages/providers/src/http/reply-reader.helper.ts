import type { StreamEvent } from '@sheavly/core/message/message.types';
import { ModelApiError } from '../errors/providers.errors.js';
import { STREAM_IDLE_MS } from './http.constants.js';
import type { ReplyProtocol } from './http.types.js';
import { readServerSentEvents } from './sse.utils.js';
import { streamChunks } from './stream-chunks.helper.js';

/**
 * Reads one started reply for every protocol, so the decisions below are made once:
 * - a payload the protocol does not use is skipped, never an error;
 * - a stream that ends before its end marker is `cut_off`, unless the caller's signal aborted,
 *   which is the caller's interrupt and goes up as it came;
 * - a reply that did end is kept even if the signal aborted after, since its events were yielded;
 * - the protocol's `finish` events are yielded only after a complete reply;
 * - a body that fails or goes silent for `idleMs` (`STREAM_IDLE_MS` unless given) is a
 *   `ConnectionLostError`, which the loop recovers from, not a reply that was wrong.
 */
export async function* readReply<TEvent>(params: {
  body: ReadableStream<Uint8Array>;
  signal: AbortSignal;
  protocol: ReplyProtocol<TEvent>;
  idleMs?: number;
}): AsyncGenerator<StreamEvent> {
  const { body, signal, protocol, idleMs = STREAM_IDLE_MS } = params;
  let ended = false;

  for await (const raw of readServerSentEvents(streamChunks({ body, idleMs, signal }))) {
    const event = protocol.parse(raw);

    if (event === undefined) continue;

    const step = protocol.step(event);

    if (step.ended) ended = true;
    if (step.events) yield* step.events;
  }

  if (!ended) {
    signal.throwIfAborted();
    throw new ModelApiError({ reason: 'cut_off', message: protocol.cutOffMessage });
  }

  yield* protocol.finish();
}

import type { ConversationId } from '@sheavly/protocol/server/server.types';
import type {
  SubscribeFrame,
  SubscribeRequest,
} from '@sheavly/protocol/subscription/subscription.types';
import { subscribeFrameSchema } from '@sheavly/protocol/subscription/subscription.validator';
import { StreamEndedError } from '../errors/client.errors.js';
import type { createClient } from './client.helper.js';
import type { ReconnectProgress } from './client.types.js';
import { RECONNECT_BUDGET_MS, RECONNECT_STABLE_MS } from './reconnect.constants.js';
import { backoffAfter, stopFailing, waitFor } from './reconnect.helper.js';
import { readSseFrames } from './sse.helper.js';
import { SubscribeProgress } from './subscribe-progress.service.js';
import { MAX_SUBSCRIBE_FRAME_CHARS } from './subscribe.constants.js';

/** One open stream: its body, and the way to leave it. */
type OpenedStream = { body: ReadableStream<Uint8Array>; leave: AbortController };

/** The frames of a subscribe stream, each parsed with the protocol's schema; a comment is none. */
async function* readSubscribeFrames(
  body: ReadableStream<Uint8Array>,
): AsyncGenerator<SubscribeFrame> {
  for await (const { data } of readSseFrames({
    body,
    route: 'streamChannels',
    maxFrameChars: MAX_SUBSCRIBE_FRAME_CHARS,
  })) {
    if (data !== undefined) yield subscribeFrameSchema.parse(JSON.parse(data));
  }
}

/**
 * The frames of one open stream that the reader is to see, until it ends or a channel is cut off on
 * it (then it is left, and the next one asks for that channel from its cursor). A frame that is
 * delivered ends the run of failed attempts, except a live one: it is told once and never replayed,
 * so a server that sent one and dropped would otherwise keep the client reconnecting for ever.
 */
async function* deliver(params: {
  stream: OpenedStream;
  progress: SubscribeProgress;
  failing: ReconnectProgress;
}): AsyncGenerator<SubscribeFrame> {
  const { stream, progress, failing } = params;

  for await (const frame of readSubscribeFrames(stream.body)) {
    const delivered = progress.accept(frame);

    if (delivered) {
      if (delivered.type !== 'live') stopFailing(failing);
      yield delivered;
    }

    if (progress.cutOff) return;
  }
}

/**
 * Waits before the next attempt, after `error`: a stream that stayed up `RECONNECT_STABLE_MS` was
 * healthy even if no frame came, so it starts the count again; then the wait doubles with every
 * attempt that failed in a row (`backoffAfter`, which throws what reconnecting cannot help and
 * `StreamLostError` past the budget).
 */
async function pauseAfter(params: {
  error: unknown;
  openedAt: number | undefined;
  failing: ReconnectProgress;
  client: ReturnType<typeof createClient>;
  signal: AbortSignal;
}): Promise<void> {
  const { error, openedAt, failing, client, signal } = params;
  const { attempts, wait = waitFor } = client.reconnect;

  if (openedAt !== undefined && performance.now() - openedAt >= RECONNECT_STABLE_MS) {
    stopFailing(failing);
  }

  const ms = backoffAfter({
    error,
    progress: failing,
    attempts,
    budgetMs: client.reconnect.budgetMs ?? RECONNECT_BUDGET_MS,
  });

  await wait({ ms, signal });
}

/**
 * Follows the channels of conversation `id` that `subscriptions` name (`QUERY /subscribe`), and
 * yields their frames: an entry of a channel, where a channel stood (`head`), the tree as it
 * stands (`snapshot`), what an item says as it happens (`live`, which has no cursor: it is yielded
 * as it comes and moves nothing) and the end of a channel (`end`, `completed` or `failed`). The
 * server keeps no state, so the client does: it holds the cursor of the last frame of each channel, and a dropped
 * connection (or a channel the server cut off because this reader did not keep up) is opened again
 * with each channel that has not ended asked from its cursor, so no frame is missed and none comes
 * twice. A channel that had no frame yet is asked from where it was first asked, so a drop before
 * the `head` of a `now` subscription reopens at `now`.
 *
 * It reads frames as they come and holds the one being read (and what one chunk of the transport
 * completes), which `MAX_SUBSCRIBE_FRAME_CHARS` bounds (a longer frame throws
 * `AnswerTooLargeError`), so a reader that is slow is cut off by the server and resumed, never
 * buffered for. The generator ends when every channel has, or when `signal` aborts; a stream that
 * cannot be reopened for `client.reconnect`'s budget throws `StreamLostError`. A refusal (4xx,
 * `cursor_out_of_range` included) is thrown as it is: asking again gets the same answer, so it is
 * for the caller to ask from somewhere else. The one refusal that is asked again is `429`, a server
 * that serves as many subscriptions as it may (it says to ask again when one has ended), once the
 * first connection is open; the first connection's refusal is thrown at once.
 *
 * `approvals` says this client answers approvals while it is connected (needs the tree channel);
 * it is sent on every connection. Resolves once the server has accepted the first connection,
 * which is when the claim counts: what the caller does next is after it. The first connection is
 * held open until the frames are read to their end or `signal` aborts.
 */
export async function subscribeChannels(params: {
  client: ReturnType<typeof createClient>;
  id: ConversationId;
  subscriptions: SubscribeRequest['subscriptions'];
  approvals?: boolean;
  signal: AbortSignal;
}): Promise<AsyncGenerator<SubscribeFrame>> {
  const { client, id, approvals, signal } = params;
  const progress = new SubscribeProgress(params.subscriptions);
  const connect = async (): Promise<OpenedStream> => {
    const leave = new AbortController();
    const body = await client.open('streamChannels', {
      id,
      body: {
        subscriptions: progress.nextRequest(),
        ...(approvals !== undefined && { approvals }),
      },
      signal: AbortSignal.any([signal, leave.signal]),
    });

    return { body, leave };
  };
  // Opened here so the caller knows the server accepted it; a reconnect opens its own.
  let first: OpenedStream | undefined = await connect();

  async function* frames(): AsyncGenerator<SubscribeFrame> {
    const failing: ReconnectProgress = {
      lastEventId: undefined,
      failures: 0,
      failingSince: undefined,
    };

    while (!signal.aborted && !progress.finished) {
      let stream: OpenedStream | undefined;
      // Set once the stream is open: time spent waiting for an answer is not one staying up.
      let openedAt: number | undefined;

      try {
        stream = first ?? (await connect());
        first = undefined;
        openedAt = performance.now();
        yield* deliver({ stream, progress, failing });

        if (progress.finished) return;

        // The stream only ends after its last channel: one that ended before is a cut.
        throw new StreamEndedError({ lastEventId: undefined });
      } catch (caughtError) {
        if (signal.aborted) return;

        await pauseAfter({ error: caughtError, openedAt, failing, client, signal });
      } finally {
        stream?.leave.abort();
      }
    }
  }

  return frames();
}

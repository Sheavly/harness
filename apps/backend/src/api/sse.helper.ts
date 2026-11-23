import type { Context } from 'hono';
import { streamSSE } from 'hono/streaming';
import type { LiveConversation } from '@sheavly/host/conversations/conversations.types';
import { ENTRY_EVENT } from '@sheavly/protocol/api/api.constants';
import type { EntryFilter } from '@sheavly/runtime/sessions/sessions.types';
import { HEARTBEAT_MS, SSE_QUEUE_LIMIT } from './api.constants.js';
import { EntryQueue } from './entry-queue.service.js';
import { isAfter } from './api.utils.js';

/**
 * A conversation's combined stream as server-sent events: each entry `filter` picks, after
 * `lastEventId` when a client resumes, as one `entry` frame whose `id` is its `seq`. With
 * `answersApprovals`, the client counts as someone who can answer them while it is open, so a
 * request waits for its answer; a client that didn't say so never makes one wait. It ends when the
 * client leaves. A stream that starts from now first sends a head frame (see below). A heartbeat
 * comment keeps a quiet stream open through proxies. Disconnecting only ends this subscription:
 * what runs goes on.
 */
export function streamEntries(params: {
  c: Context;
  live: LiveConversation;
  filter: EntryFilter;
  lastEventId?: number | undefined;
  answersApprovals?: boolean;
}) {
  const { c, live, filter, lastEventId, answersApprovals = false } = params;

  c.header('X-Accel-Buffering', 'no'); // a buffering proxy (nginx) would hold events back

  return streamSSE(c, async (stream) => {
    // Read before subscribing: what is below it is history, which a resume replays in bulk.
    const liveFrom = live.harness.sessions.nextSeq();
    const queue = new EntryQueue({ limit: SSE_QUEUE_LIMIT, liveFrom });
    let wake: (() => void) | undefined;
    let ended = false;
    const end = () => {
      ended = true;
      wake?.();
    };
    const unsubscribe = live.harness.sessions.subscribeEntries((entry) => {
      if (!isAfter({ entry, lastEventId })) return;

      // A consumer too slow to keep up is cut off, not buffered for: it resumes where it left off.
      if (!queue.push(entry)) end();
      wake?.();
    }, filter);
    // Listening makes an approval wait for an answer; the answer comes as its own request.
    const stopListening = answersApprovals
      ? live.harness.approvals.subscribe(() => undefined)
      : () => undefined;
    const heartbeat = setInterval(() => void stream.write(': heartbeat\n\n'), HEARTBEAT_MS);

    stream.onAbort(end);

    try {
      // A live stream that starts from now says where "now" is, as a frame with an `id` and nothing
      // else (SSE sets the last event id from it), so a client that gets no entry before the
      // connection drops can still resume after it and not miss what is made meanwhile.
      if (!filter.replay && lastEventId === undefined && liveFrom > 0) {
        await stream.write(`id: ${String(liveFrom - 1)}\n\n`);
      }

      while (!ended) {
        const entry = queue.shift();

        if (!entry) {
          await new Promise<void>((resolve) => (wake = resolve));
          continue;
        }

        await stream.writeSSE({
          event: ENTRY_EVENT,
          id: String(entry.seq),
          data: JSON.stringify(entry),
        });
      }
    } finally {
      clearInterval(heartbeat);
      stopListening();
      unsubscribe();
    }
  });
}

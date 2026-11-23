import type { ConversationId } from '@sheavly/protocol/server/server.types';
import type { SessionId } from '@sheavly/protocol/session/session.types';
import type { StreamEntry } from '@sheavly/protocol/stream/stream.types';
import type { createClient } from '../client/client.helper.js';
import { RefusedError } from '../errors/client.errors.js';
import { followConversation } from '../client/follow.helper.js';
import type { AgentSession, HeardApproval } from './approvals.types.js';

/**
 * Follows `entries` (a conversation's stream from its start) and calls `onApproval` for every
 * approval update, saying which sub-agent asked. Sessions are learned from the same stream, so
 * it has to include the `session_*` updates before the approvals: a replayed stream does. An
 * entry's session is only remembered from its updates, never copied into the approval itself.
 * Ends with the stream; a failure rejects unless `signal` aborted, which is how it is stopped.
 */
export async function followApprovals(params: {
  entries: AsyncIterable<StreamEntry>;
  onApproval: (heard: HeardApproval) => void;
  /** Every entry, approvals included, for a UI that also reads usage or tasks from this stream. */
  onEntry?: (entry: StreamEntry) => void;
  signal: AbortSignal;
}): Promise<void> {
  const { entries, onApproval, onEntry, signal } = params;
  const agents = new Map<SessionId, AgentSession>();

  try {
    for await (const entry of entries) {
      if (entry.kind === 'update' && 'parentId' in entry.update.session) {
        agents.set(entry.update.session.id, entry.update.session);
      }

      onEntry?.(entry);
      if (entry.kind !== 'approval') continue;

      const agent = agents.get(entry.sessionId);

      onApproval({
        update: entry.update,
        sessionId: entry.sessionId,
        ...(agent && { agent }),
      });
    }
  } catch (caughtError) {
    if (!signal.aborted) throw caughtError;
  }
}

/**
 * Runs `answer` (a call to `answerApproval`), and treats an approval that is no longer waiting
 * (`unknown_approval`: someone answered first, or its call was interrupted) as done, not a failure.
 * Every other error is thrown. The one place a UI's answer gets that rule, so none re-implements it.
 */
export async function answerWhileWaiting(answer: () => Promise<void>): Promise<void> {
  try {
    await answer();
  } catch (caughtError) {
    if (caughtError instanceof RefusedError && caughtError.code === 'unknown_approval') return;

    throw caughtError;
  }
}

/**
 * Starts answering a conversation's approvals: opens its stream as one that answers them (so a
 * command waits for the user instead of being refused) and replays it from the start, so the
 * sub-agents that already run are known by name. Resolves once the backend has accepted the
 * stream, which is when it counts: send the first prompt after this. `ended` is `followApprovals`.
 * An approval still waiting is replayed too: a UI keyed by `update`'s id shows it once.
 *
 * A dropped stream is reopened after the last entry heard (`reconnectingEntries`), so each entry
 * reaches `onApproval` once. `ended` rejects with `StreamLostError` when it gives up. While it is
 * down nobody listens for approvals, so a request made then is refused rather than waiting.
 */
export async function watchApprovals(params: {
  client: ReturnType<typeof createClient>;
  id: ConversationId;
  onApproval: (heard: HeardApproval) => void;
  onEntry?: (entry: StreamEntry) => void;
  signal: AbortSignal;
}): Promise<{ ended: Promise<void> }> {
  const { client, id, signal, ...handlers } = params;
  const entries = await followConversation({
    client,
    id,
    body: { approvals: true, replay: true },
    signal,
  });

  return { ended: followApprovals({ entries, signal, ...handlers }) };
}

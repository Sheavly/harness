import type { QueueUpdate } from '@sheavly/protocol/queue/queue.types';
import type { LiveConversation } from './conversations.types.js';

/**
 * Puts a change of the conversation's queue on its stream (a `queue` entry, as before) and on its
 * tree channel, where a client that follows only that learns what waits and which line started.
 * A line that starts is told with the user message it became, which the main session has by now;
 * a conversation whose tree is not kept (no store) has only the stream.
 */
export function publishQueueUpdate(params: { live: LiveConversation; update: QueueUpdate }): void {
  const { live, update } = params;
  const { harness } = live;
  const tree = harness.treeChannel;

  harness.sessions.publishQueue({ sessionId: harness.mainSession.id, update });

  if (!tree) return;

  if (update.type === 'queue_changed') {
    tree.noteQueueChanged(update.queued);

    return;
  }

  if (update.type === 'prompt_refused') {
    tree.notePromptRefused(update);

    return;
  }

  const messageId = harness.sessions.messageOf(harness.mainSession.id);

  if (messageId) tree.notePromptStarted({ ...update, messageId });
}

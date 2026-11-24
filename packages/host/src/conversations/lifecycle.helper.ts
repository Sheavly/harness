import { StoreError } from '@sheavly/core/errors/store.errors';
import type { LiveConversation } from './conversations.types.js';
import type { ConversationKeeper } from './keeper.service.js';
import { announceStorageFailure } from './storage.helper.js';

/**
 * Ends a conversation that is no longer live: closes it, releases what the app opened for it,
 * marks it closed in the index, and waits for every store it writes (the index and history, the
 * stream, each node's channel), so nothing is half written when it returns. A conversation reopened
 * after this finds all of it. Releasing can throw, and the conversation is closed and gone from the
 * live ones all the same, so the index and the stores are still marked and awaited then: a reopen
 * waits for this call (`Conversations.reopen`), and must find what the stopped conversation wrote.
 */
export async function closeLiveConversation(params: {
  live: LiveConversation;
  keeper: ConversationKeeper | undefined;
}): Promise<void> {
  const { live, keeper } = params;

  try {
    await live.conversation.close();
    await live.dispose?.();
  } finally {
    keeper?.keepIndex({ status: 'closed' });
    await keeper?.flush();
    await live.harness.sessions.flushStore();
    await live.harness.nodeChannels?.flush();
  }
}

/**
 * Announces, on the stream of a conversation that just became live, what went wrong with its
 * channels before there was a stream to say it on: a write that failed while it was being built,
 * and the channels a reopen could not close (`repairs`). The channels are one announcement however
 * many they are, naming how many and the first one's reason, so a conversation with thousands of
 * damaged files does not flood its own stream on every reopen. None ends a run: the stream is the
 * record.
 */
export function announceChannelFailures(params: {
  live: LiveConversation;
  repairs: readonly { failure: StoreError }[];
}): void {
  const { live, repairs } = params;
  const early = live.harness.nodeChannels?.failure;
  const [first] = repairs;

  if (early) announceStorageFailure({ live, failure: early });

  if (!first) return;

  const many =
    repairs.length === 1
      ? 'A stored node channel'
      : `${String(repairs.length)} stored node channels`;

  announceStorageFailure({
    live,
    failure: new StoreError({
      reason: 'failed',
      message: `${many} could not be closed as lost, and reads as it was left (first: ${first.failure.message})`,
    }),
  });
}

import { now } from '@sheavly/core/clock/clock.helper';
import { StoreError } from '@sheavly/core/errors/store.errors';
import type { ConversationId } from '@sheavly/protocol/server/server.types';
import type { LiveConversation } from './conversations.types.js';
import { summaryOf } from './conversations.utils.js';
import type { ConversationKeeper } from './keeper.service.js';
import { announceStorageFailure } from './storage.helper.js';

/**
 * Writes the index entry a new conversation starts with, now that its title and model exist, and
 * records the model on the main session: the first `session_model` of its stream.
 */
export function beginConversation(params: {
  id: ConversationId;
  live: LiveConversation;
  keeper: ConversationKeeper | undefined;
}): void {
  const { id, live, keeper } = params;
  const summary = summaryOf({ id, live });
  const { model, workspace, profile } = live.run.details();
  const effort = model.effort ?? 'medium';

  live.harness.sessions.setModel({
    id: live.harness.mainSession.id,
    modelId: model.id,
    effort,
  });
  keeper?.begin({
    id,
    title: summary.title,
    modelId: model.id,
    effort,
    workspace,
    profile,
    status: 'open',
    startedAt: summary.startedAt,
    updatedAt: now(),
  });
}

/**
 * Ends a conversation that is no longer live: closes it, releases what the app opened for it,
 * marks it closed in the index, and waits for every store it writes (the index and history, the
 * stream, each node's channel, the tree channel), so nothing is half written when it returns. A conversation reopened
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
    try {
      keeper?.keepIndex({ status: 'closed' });
      await keeper?.flush();
      await live.harness.sessions.flushStore();
      await live.harness.nodeChannels?.flush();
    } finally {
      // After the close, so the nodes it ended are on the tree, and whatever a flush above did: a
      // writer that is never stopped leaves a client that follows the tree waiting for ever. It
      // stops and does not close the channel: the conversation is kept, and a reopen goes on from it.
      await live.harness.conversationChannels?.stop();
    }
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
  // A disk that fails fails every writer with one message, told once; a different failure of
  // another writer (a tree channel that cannot be gone on from) is told too.
  const early = [
    live.harness.nodeChannels?.failure,
    ...(live.harness.conversationChannels?.failures ?? []),
  ].filter(
    (failure, index, all): failure is StoreError =>
      failure !== undefined &&
      all.findIndex((other) => other?.message === failure.message) === index,
  );
  const [first] = repairs;

  for (const failure of early) announceStorageFailure({ live, failure });

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

import type { StoreError } from '@sheavly/core/errors/store.errors';
import type { ConversationStore } from '@sheavly/core/store/store.types';
import { ConversationsError } from '../errors/conversations.errors.js';
import type { ConversationId } from '@sheavly/protocol/server/server.types';
import type { LiveConversation, StorageOf } from './conversations.types.js';
import type { ConversationKeeper } from './keeper.service.js';

/** Throws `storage_failed` for conversation `id` when `failure` is set; nothing otherwise. */
export function refuseWhenStorageFailed(params: {
  id: ConversationId;
  failure: StoreError | undefined;
}): void {
  const { id, failure } = params;

  if (!failure) return;

  throw new ConversationsError({
    reason: 'storage_failed',
    message: `Conversation ${id} could not be stored (${failure.message}), so it takes no more prompts rather than carry on unrecorded`,
    cause: failure,
  });
}

/** Puts `storage_failed` on the conversation's stream, under its main session. */
export function announceStorageFailure(params: {
  live: LiveConversation | undefined;
  failure: StoreError;
}): void {
  if (!params.live) return;

  const { harness } = params.live;

  harness.sessions.publish({
    sessionId: harness.mainSession.id,
    event: { seq: 0, type: 'storage_failed', error: params.failure.message },
  });
}

/**
 * What the app builds conversation `id` on so it is kept: its stream's store, its history and its
 * nodes' channels. `onChannelFailure` is told once when a channel write fails.
 */
export function storageOf(params: {
  store: ConversationStore | undefined;
  keeper: ConversationKeeper | undefined;
  id: ConversationId;
  onChannelFailure: (failure: StoreError) => void;
}): StorageOf {
  const { store, keeper, id, onChannelFailure } = params;

  if (!keeper || !store) return {};

  return {
    storage: {
      entries: store.entries(id),
      shell: store.shell(id),
      outputs: store.outputs(id),
      channels: { log: (channel) => store.channel({ id, channel }), onFailure: onChannelFailure },
      keepHistory: (messages) => keeper.keepHistory(messages),
      keepAgentHistory: (agent) => keeper.keepAgentHistory(agent),
      logOf: ({ session, main }) => store.history({ id, session: main ? undefined : session }),
    },
  };
}

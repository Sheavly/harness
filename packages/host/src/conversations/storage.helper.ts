import type { StoreError } from '@sheavly/core/errors/store.errors';
import type { ConversationStore } from '@sheavly/core/store/store.types';
import type { ResumedTree } from '@sheavly/runtime/nodes/nodes.types';
import type { ResumedChannel } from '@sheavly/runtime/nodes/stored-channel.types';
import type { UsageView } from '@sheavly/protocol/usage/usage.types';
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

/**
 * Puts `storage_failed` on the conversation's stream, under its main session, and on its tree
 * channel, where a client that follows only that learns of it. A tree channel that cannot be
 * written takes no more, so its own failure is not repeated there.
 */
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
  harness.treeChannel?.noteStorageFailed(params.failure.message);
}

/**
 * What the app builds conversation `id` on so it is kept: its stream's store, its history and its
 * channels. The channels share a disk, so they fail together with one message: `onChannelFailure`
 * is told each distinct failure once, though every writer hits it.
 */
export function storageOf(params: {
  store: ConversationStore | undefined;
  keeper: ConversationKeeper | undefined;
  id: ConversationId;
  onChannelFailure: (failure: StoreError) => void;
  /** What the stored channels left, for a reopened conversation's writers to go on from. */
  resumed?: {
    tree?: ResumedTree | undefined;
    usage?: ResumedChannel<UsageView> | undefined;
  };
}): StorageOf {
  const { store, keeper, id, onChannelFailure, resumed } = params;
  const told = new Set<string>();

  if (!keeper || !store) return {};

  return {
    storage: {
      entries: store.entries(id),
      shell: store.shell(id),
      outputs: store.outputs(id),
      channels: {
        log: (channel) => store.channel({ id, channel }),
        onFailure: (failure) => {
          if (told.has(failure.message)) return;

          told.add(failure.message);
          onChannelFailure(failure);
        },
        resumedTree: resumed?.tree,
        resumedUsage: resumed?.usage,
        reopened: resumed !== undefined,
      },
      keepHistory: (messages) => keeper.keepHistory(messages),
      keepAgentHistory: (agent) => keeper.keepAgentHistory(agent),
      logOf: ({ session, main }) => store.history({ id, session: main ? undefined : session }),
    },
  };
}

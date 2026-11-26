import type { StoreError } from '@sheavly/core/errors/store.errors';
import type { ChannelEntry } from '@sheavly/core/store/store.types';
import type { UsageView } from '@sheavly/protocol/usage/usage.types';
import type { MemoryConversationStore } from '@sheavly/testing/store/memory-store.fake';
import type { ResumedChannel } from '../nodes/stored-channel.types.js';
import { UsageChannelWriter } from '../nodes/usage-channel-writer.service.js';
import { readChannel } from './stored-channels.fake.js';
import { conversation, conversationId } from './stored-conversation.fake.js';

/**
 * Test-only: a conversation (`conversation`) whose usage channel is stored too, in the same memory
 * store, counting what the loops of its sessions report. `usageFailures` hears what the usage
 * writer reports; the node channels' is `failures`.
 */
export function usageConversation(
  params: {
    store?: MemoryConversationStore;
    resumed?: ResumedChannel<UsageView> | undefined;
    /** A reopened conversation, whether or not a usage channel was stored for it. */
    reopened?: boolean;
  } = {},
) {
  const world = conversation({ ...(params.store && { store: params.store }) });
  const usageFailures: StoreError[] = [];
  const usage = UsageChannelWriter.attach({
    nodes: world.sessions.nodes,
    events: world.sessions,
    storage: {
      log: (channel) => world.store.channel({ id: conversationId, channel }),
      onFailure: (failure) => usageFailures.push(failure),
      resumedUsage: params.resumed,
      reopened: params.reopened ?? false,
    },
  });

  return { ...world, usage, usageFailures };
}

/**
 * Test-only: the same conversation reopened by another process: a new set of registries (a main
 * agent of its own) on `store`, whose usage writer goes on from what the stopped process stored.
 */
export async function reopenedUsageConversation(store: MemoryConversationStore) {
  const resumed = await UsageChannelWriter.readStored({ store, id: conversationId });

  return usageConversation({ store, resumed, reopened: true });
}

/** Test-only: every entry of the usage channel, once the writes so far have landed. */
export async function usageEntriesOf(
  world: Pick<ReturnType<typeof usageConversation>, 'store' | 'usage'>,
): Promise<ChannelEntry[]> {
  await world.usage.flush();

  return readChannel({ store: world.store, id: conversationId, channel: 'usage' });
}

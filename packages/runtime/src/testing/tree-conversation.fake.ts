import type { StoreError } from '@sheavly/core/errors/store.errors';
import type { ChannelEntry } from '@sheavly/core/store/store.types';
import type { MemoryConversationStore } from '@sheavly/testing/store/memory-store.fake';
import { ApprovalRegistry } from '../approvals/approvals.service.js';
import { TreeChannelWriter } from '../nodes/tree-channel-writer.service.js';
import { readChannel } from './stored-channels.fake.js';
import { conversation, conversationId } from './stored-conversation.fake.js';

/**
 * Test-only: a conversation (`conversation`) whose tree channel is stored too, in the same memory
 * store, with an approval registry that has a listener, so a request waits instead of failing for
 * want of one. `treeFailures` hears what the tree writer reports; the node channels' is `failures`.
 */
export function treeConversation(params: { store?: MemoryConversationStore } = {}) {
  const world = conversation(params);
  const approvals = new ApprovalRegistry();
  const treeFailures: StoreError[] = [];

  approvals.subscribe(() => undefined);

  const tree = TreeChannelWriter.attach({
    nodes: world.sessions.nodes,
    tasks: world.tasks,
    approvals,
    nodeIdOf: (session) => world.sessions.nodeIdOf(session),
    storage: {
      log: (channel) => world.store.channel({ id: conversationId, channel }),
      onFailure: (failure) => treeFailures.push(failure),
    },
  });

  return { ...world, approvals, tree, treeFailures };
}

/** Test-only: every entry of the tree channel, once the writes so far have landed. */
export async function treeEntriesOf(
  world: Pick<ReturnType<typeof treeConversation>, 'store' | 'tree'>,
): Promise<ChannelEntry[]> {
  await world.tree.flush();

  return readChannel({ store: world.store, id: conversationId, channel: 'tree' });
}

import type { ConversationId } from '@sheavly/protocol/server/server.types';
import { treeChannelEntrySchema } from '@sheavly/protocol/tree/tree.validator';
import { readChannel } from '@sheavly/runtime/testing/stored-channels.fake';
import type { MemoryConversationStore } from '@sheavly/testing/store/memory-store.fake';
import type { Harness } from '../host/host.types.js';

/**
 * Test-only: every entry of the stored tree channel, once what was told is written, as the
 * contract reads it.
 */
export async function storedTreeOf(world: {
  store: MemoryConversationStore;
  id: ConversationId;
  harness: Harness;
}) {
  await world.harness.treeChannel?.flush();

  const entries = await readChannel({ store: world.store, id: world.id, channel: 'tree' });

  return entries.map((entry) => treeChannelEntrySchema.parse(entry));
}

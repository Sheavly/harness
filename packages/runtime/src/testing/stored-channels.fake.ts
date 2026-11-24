import type { ChannelEntry, ConversationStore } from '@sheavly/core/store/store.types';
import type { ConversationId } from '@sheavly/protocol/server/server.types';

/** Test-only: every entry of channel `channel` of conversation `id` in `store`, oldest first. */
export async function readChannel(params: {
  store: Pick<ConversationStore, 'channel'>;
  id: ConversationId;
  channel: string;
}): Promise<ChannelEntry[]> {
  const entries: ChannelEntry[] = [];

  for await (const entry of params.store
    .channel({ id: params.id, channel: params.channel })
    .read()) {
    entries.push(entry);
  }

  return entries;
}

/** Test-only: a channel's entries as `type cursor` lines, to compare its shape at a glance. */
export const shapeOf = (entries: ChannelEntry[]) =>
  entries.map((each) => `${each.type} ${each.cursor}`);

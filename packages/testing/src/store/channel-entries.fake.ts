import type { ChannelEntry, ChannelFrom, ConversationStore } from '@sheavly/core/store/store.types';
import { conversationIdSchema } from '@sheavly/protocol/server/server.validator';

/** Test-only: an entry wrong in a way its type does not allow, as a caller can still send one at run time. */
export const past = (entry: Record<string, unknown>): never => entry as never;

/** Test-only: the two conversations the channel contract tests keep channels in. */
export const first = conversationIdSchema.parse('00000000-0000-4000-8000-0000000000a1');
export const second = conversationIdSchema.parse('00000000-0000-4000-8000-0000000000a2');

/**
 * Test-only: an entry of `channel` (a node id, or `tree`; `main` by default) with this type and
 * cursor, holding the node it is about as a channel's entries do.
 */
export const entryOf = (params: {
  type: string;
  cursor: string;
  channel?: string;
}): ChannelEntry => ({
  channel: params.channel ?? 'main',
  type: params.type,
  cursor: params.cursor,
  at: 0,
  node: { id: params.channel ?? 'main', title: 'Chat' },
});

/** Test-only: what an entry costs in a limit: its line, as a store keeps it. */
export const lineBytes = (entry: ChannelEntry) => Buffer.byteLength(JSON.stringify(entry)) + 1;

/** Test-only: the cursors `channel` of `conversation` reads back from `from`. */
export async function cursorsOf(params: {
  store: ConversationStore;
  channel?: string;
  conversation?: typeof first;
  from?: ChannelFrom | undefined;
}) {
  const { store, channel = 'main', conversation = first, from } = params;
  const cursors: string[] = [];

  for await (const each of store.channel({ id: conversation, channel }).read(from)) {
    cursors.push(each.cursor);
  }

  return cursors;
}

/** Test-only: appends `entries` one after another, each to the channel it names. */
export async function appendAll(params: {
  store: ConversationStore;
  entries: ChannelEntry[];
  conversation?: typeof first;
}) {
  const { store, entries, conversation = first } = params;

  for (const each of entries) {
    await store.channel({ id: conversation, channel: each.channel }).append(each);
  }
}

/** Test-only: the entries of one channel's life, `main`'s, from opened to closed. */
export const OPENED = entryOf({ type: 'opened', cursor: 's0' });
export const UPDATED = entryOf({ type: 'updated', cursor: 's1' });
export const UPDATED_AGAIN = entryOf({ type: 'updated', cursor: 's2' });
export const CLOSED = entryOf({ type: 'closed', cursor: 's3' });

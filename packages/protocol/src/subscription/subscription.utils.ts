import type { ConversationChannelName, CursorKind } from '../channel/channel.types.js';
import { treeChannelEntrySchema } from '../tree/tree.validator.js';
import { usageChannelEntrySchema } from '../usage/usage-channel.validator.js';
import { MAX_TAIL, MAX_TAIL_BYTES, TAIL_PREFIX } from './subscription.constants.js';

/**
 * The schema of an entry of the conversation's own channel `name`. One case for each name of
 * `CONVERSATION_CHANNEL_NAMES`: a name added there fails the type check here until its case is
 * written, so a channel is never served without a schema for what it holds.
 */
export function conversationEntrySchema(name: ConversationChannelName) {
  switch (name) {
    case 'tree':
      return treeChannelEntrySchema;
    case 'usage':
      return usageChannelEntrySchema;
  }
}

/** The `n` of a `tail:<n>` position, or undefined for a position that is not a tail. */
export function tailCount(from: string): number | undefined {
  return from.startsWith(TAIL_PREFIX) ? Number(from.slice(TAIL_PREFIX.length)) : undefined;
}

/** The most a `tail` may ask for on a channel whose cursor counts `kind`. */
export function tailLimit(kind: CursorKind): number {
  return kind === 'sequence' ? MAX_TAIL : MAX_TAIL_BYTES;
}

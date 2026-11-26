import { CONVERSATION_CHANNEL_NAMES } from '../node/node.constants.js';
import type { ChannelHead, ConversationChannelName, CursorKind } from './channel.types.js';

/**
 * Whether `name` is one of the conversation's own channels (`tree`), as opposed to a node's,
 * which is its id. These number their entries, have a view to start from (`snapshot`), and are
 * names no node may have.
 */
export function isConversationChannel(name: string): name is ConversationChannelName {
  return (CONVERSATION_CHANNEL_NAMES as readonly string[]).includes(name);
}

/** What a cursor counts, read from the letter it starts with. It takes a cursor the schema accepted. */
export function cursorKind(cursor: string): CursorKind {
  return cursor.startsWith('s') ? 'sequence' : 'byte';
}

/** The number a cursor holds: a position, or an offset in bytes. */
export function cursorNumber(cursor: string): number {
  return Number(cursor.slice(1));
}

/**
 * The cursors a node's channel may use. An agent's channel numbers its entries, a command's or a
 * service's counts the bytes of its output, and a kind an extension adds chooses one of the two.
 */
export function channelCursorKinds(nodeKind: string): readonly CursorKind[] {
  if (nodeKind === 'agent') return ['sequence'];
  if (nodeKind === 'command' || nodeKind === 'service') return ['byte'];

  return ['sequence', 'byte'];
}

/** Whether the entry at `index` of a log of `length` has the place its type allows. */
function typeFits(params: { type: string; index: number; length: number }): boolean {
  const { type, index, length } = params;

  if (type === 'opened') return index === 0;
  if (type === 'closed') return index === length - 1;

  return true;
}

/** Whether the cursor of the entry at `index` follows from the one before it. */
function cursorFits(params: {
  kind: CursorKind;
  cursor: string;
  index: number;
  previous: string | undefined;
}): boolean {
  const { kind, cursor, index, previous } = params;

  if (cursorKind(cursor) !== kind) return false;
  if (kind === 'sequence') return cursorNumber(cursor) === index;
  if (previous === undefined) return cursorNumber(cursor) === 0;

  return cursorNumber(cursor) >= cursorNumber(previous);
}

/**
 * Whether the entries of one channel, oldest first, have the shape a channel has. It starts with
 * `opened` and ends with `closed`, each once; every entry names the same channel and uses cursors
 * of one kind; a sequence has no gap and a byte offset never goes back; and a conversation's own
 * channel numbers its entries. An empty log is well formed: nothing has opened the channel yet. What each
 * entry holds is checked by its own schema, which only the issue that serves that type has.
 */
export function isWellFormedChannelLog(entries: readonly ChannelHead[]): boolean {
  const [first] = entries;

  if (first === undefined) return true;
  if (first.type !== 'opened') return false;

  const kind = cursorKind(first.cursor);

  if (isConversationChannel(first.channel) && kind !== 'sequence') return false;

  return entries.every(
    (entry, index) =>
      entry.channel === first.channel &&
      typeFits({ type: entry.type, index, length: entries.length }) &&
      cursorFits({ kind, cursor: entry.cursor, index, previous: entries[index - 1]?.cursor }),
  );
}

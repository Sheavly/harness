import { StoreError } from '../errors/store.errors.js';
import { TREE_CHANNEL_NAME } from '@sheavly/protocol/node/node.constants';
import { MAX_CHANNEL_ENTRY_CHARS } from '@sheavly/protocol/channel/channel.constants';
import type { ChannelHead } from '@sheavly/protocol/channel/channel.types';
import { cursorKind, cursorNumber } from '@sheavly/protocol/channel/channel.utils';
import {
  channelLogSchema,
  channelNameSchema,
  cursorSchema,
} from '@sheavly/protocol/channel/channel.validator';
import { MAX_TAIL } from '@sheavly/protocol/subscription/subscription.constants';
import type { ChannelEntry, ChannelFrom } from './store.types.js';

/** Why `entry` cannot open a channel, or `undefined` when it can: `opened`, at the start. */
function firstProblem(entry: ChannelHead): string | undefined {
  if (entry.type !== 'opened') {
    return `channel ${entry.channel} has no entries, so its first must be opened, not ${entry.type}`;
  }

  if (cursorNumber(entry.cursor) !== 0) {
    return `channel ${entry.channel} starts at cursor ${entry.cursor}, not at 0`;
  }

  return entry.channel === TREE_CHANNEL_NAME && cursorKind(entry.cursor) !== 'sequence'
    ? 'the tree channel is numbered, so its cursors are sequence cursors'
    : undefined;
}

/** Why `entry` cannot follow `last` in one channel, or `undefined` when it can. */
function nextProblem(params: { entry: ChannelHead; last: ChannelHead }): string | undefined {
  const { entry, last } = params;

  if (entry.channel !== last.channel) {
    return `an entry of channel ${entry.channel} cannot go after one of channel ${last.channel}`;
  }

  if (last.type === 'closed') return `channel ${entry.channel} is closed`;

  if (entry.type === 'opened') return `channel ${entry.channel} is already open`;

  if (cursorKind(entry.cursor) !== cursorKind(last.cursor)) {
    return `channel ${entry.channel} uses ${cursorKind(last.cursor)} cursors, not ${entry.cursor}`;
  }

  const next = cursorNumber(last.cursor) + 1;

  // A sequence has no gap and no repeat; a byte offset only ever goes forward.
  if (cursorKind(entry.cursor) === 'sequence' && cursorNumber(entry.cursor) !== next) {
    return `channel ${entry.channel} expected cursor s${String(next)}, got ${entry.cursor}`;
  }

  return cursorNumber(entry.cursor) < cursorNumber(last.cursor)
    ? `channel ${entry.channel} cannot go back from ${last.cursor} to ${entry.cursor}`
    : undefined;
}

/**
 * Why `entry` cannot be the next entry of its channel, or `undefined` when it can. `last` is the
 * channel's last stored entry, `undefined` for a channel nothing was written to. It is the rule of
 * `ChannelLog.append`, and the same one `isWellFormedChannelLog` holds a whole log to, so a log
 * built by appends is well formed: the first entry is `opened` at cursor 0, the cursor then goes
 * on (a sequence by one, a byte offset never back) in one kind, nothing opens twice, and nothing
 * follows `closed`. Every store applies it, so the memory fake and a file cannot disagree. The
 * message names the channel and the cursor, never what an entry holds.
 */
export function channelAppendProblem(params: {
  entry: ChannelHead;
  last: ChannelHead | undefined;
}): string | undefined {
  const { entry, last } = params;

  if (!channelNameSchema.safeParse(entry.channel).success) {
    return 'a channel is named for a node id or is the tree';
  }

  if (!cursorSchema.safeParse(entry.cursor).success) {
    return `channel ${entry.channel} was given something that is not a cursor`;
  }

  return last === undefined ? firstProblem(entry) : nextProblem({ entry, last });
}

/**
 * `entry` as JSON text, or `undefined` for one that is not JSON (a bigint, a cycle, a `toJSON` that
 * gives nothing). This is what a store writes, so it is what is checked.
 */
function jsonOf(entry: ChannelEntry): string | undefined {
  try {
    const text: string | undefined = JSON.stringify(entry);

    return text;
  } catch (caughtError) {
    // Only what JSON.stringify refuses is an entry that is not JSON; any other failure is not ours.
    if (caughtError instanceof TypeError) return undefined;
    throw caughtError;
  }
}

/**
 * The entry a store keeps for `entry`, or why it keeps none. It is JSON, at most
 * `MAX_CHANNEL_ENTRY_CHARS` long, and the shape a stored line is read as
 * (`channelLogSchema.element`: the channel, a cursor, a type, when it was written), and what is
 * kept is that text parsed again: a plain copy that a `toJSON` or a getter on the caller's object
 * can no longer change. Whatever a store checks next, and whatever it writes, is that copy. A
 * store never keeps what it could not read. The message never holds what an entry holds, nor a
 * name it has not validated.
 */
export function storedChannelEntry(
  entry: ChannelEntry,
): { entry: ChannelEntry } | { problem: string } {
  const text = jsonOf(entry);

  if (text === undefined) return { problem: 'an entry of a channel is JSON' };

  if (text.length > MAX_CHANNEL_ENTRY_CHARS) {
    return {
      problem: `an entry of a channel is at most ${String(MAX_CHANNEL_ENTRY_CHARS)} characters`,
    };
  }

  const parsed = channelLogSchema.element.safeParse(JSON.parse(text));

  return parsed.success
    ? { entry: parsed.data }
    : { problem: 'an entry of a channel has a channel, a cursor, a type and when it was written' };
}

/**
 * What a store does with `entry` appended to channel `channel` after `last` (`undefined` for the
 * channel's first): the entry to keep and write (`storedChannelEntry`), or the `StoreError` that
 * refuses it. `invalid` is an entry a store could not read back, `out_of_order` one that is another
 * channel's or cannot come next (`channelAppendProblem`, checked on the copy that is kept). Every
 * store appends through it, so the memory fake and a file refuse the same entries for the same
 * reasons, and keep the same ones, and the one place that knows what a channel's entry is stays
 * here.
 */
export function channelAppendEntry(params: {
  entry: ChannelEntry;
  channel: string;
  last: ChannelHead | undefined;
}): { entry: ChannelEntry } | { error: StoreError } {
  const { entry, channel, last } = params;
  const stored = storedChannelEntry(entry);

  if ('problem' in stored) {
    return { error: new StoreError({ reason: 'invalid', message: stored.problem }) };
  }

  // The kept copy passed its schema, so its channel is a name and short enough to quote.
  const problem =
    stored.entry.channel === channel
      ? channelAppendProblem({ entry: stored.entry, last })
      : `an entry of channel ${stored.entry.channel} cannot go in channel ${channel}`;

  return problem === undefined
    ? { entry: stored.entry }
    : { error: new StoreError({ reason: 'out_of_order', message: problem }) };
}

/** Throws a `StoreError` unless `channel` is a node id or `tree`, the only names that become a file. */
export function assertChannelName(channel: string): void {
  if (channelNameSchema.safeParse(channel).success) return;

  throw new StoreError({
    reason: 'failed',
    message: 'A channel is named for a node id or is the tree',
  });
}

/**
 * Why `from` cannot start a read, or `undefined` when it can: a `tail` is a whole number from 0
 * to `MAX_TAIL` (a store keeps that many entries in memory to read it), and an `after` is a cursor.
 */
export function channelFromProblem(from: ChannelFrom): string | undefined {
  if (typeof from === 'string') return undefined;

  if ('after' in from) {
    return cursorSchema.safeParse(from.after).success ? undefined : 'after takes a cursor';
  }

  return Number.isSafeInteger(from.tail) && from.tail >= 0 && from.tail <= MAX_TAIL
    ? undefined
    : `a tail is a whole number of entries, from 0 to ${String(MAX_TAIL)}`;
}

/**
 * A storage error as a `StoreError`: one a store already raised is kept as it is, any other is
 * wrapped with `message` and kept as its `cause`.
 */
export function toStoreError(params: { error: unknown; message: string }): StoreError {
  const { error, message } = params;

  return error instanceof StoreError
    ? error
    : new StoreError({ reason: 'failed', message, cause: error });
}

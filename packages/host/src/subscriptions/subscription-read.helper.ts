import { z } from 'zod';
import { StoreError } from '@sheavly/core/errors/store.errors';
import type { ChannelEntry, ChannelFrom, ChannelLog } from '@sheavly/core/store/store.types';
import type { CursorKind } from '@sheavly/protocol/channel/channel.types';
import { cursorKind, cursorNumber } from '@sheavly/protocol/channel/channel.utils';
import { nodeIdSchema } from '@sheavly/protocol/node/node.validator';
import type { OutputRef } from '@sheavly/protocol/output/output.types';
import { outputRefSchema } from '@sheavly/protocol/output/output.validator';
import { SNAPSHOT_EVENT } from '@sheavly/protocol/subscription/subscription.constants';
import { tailCount, tailLimit } from '@sheavly/protocol/subscription/subscription.utils';
import type { TreeChannelWriter } from '@sheavly/runtime/nodes/tree-channel-writer.service';
import { ConversationsError } from '../errors/conversations.errors.js';
import { SubscriptionError } from '../errors/subscription.errors.js';
import type { HeldBytes } from './held-bytes.service.js';
import { MAX_SUBSCRIBE_READ_BYTES, NO_SUCH_CHANNEL } from './subscriptions.constants.js';
import { treeSnapshotOf } from './tree-snapshot.helper.js';
import type { Selection } from './subscriptions.types.js';

/** What the entry costs to hold: its JSON, as a store counts a line. */
const sizeOf = (entry: ChannelEntry): number => JSON.stringify(entry).length;

/**
 * Charges `entry` to the request's read `budget` and to the conversation's `pool`, and counts it in
 * `taken`, what the read holds of the pool: past either the request is refused, never cut.
 */
export function holdEntry(params: {
  entry: ChannelEntry;
  budget: { left: number };
  pool: HeldBytes;
  taken: { bytes: number };
}): void {
  const { entry, budget, pool, taken } = params;
  const size = sizeOf(entry);

  budget.left -= size;

  if (budget.left < 0) throw tooLarge();

  if (!pool.take(size)) throw tooMuchHeld();

  taken.bytes += size;
}

/**
 * What a channel's cursors count, from the newest entry it holds (a channel keeps one kind from its
 * first entry, so it is the first's too); none for a channel with no entry. Nothing is read.
 */
export async function kindOf(log: ChannelLog): Promise<CursorKind | undefined> {
  const { newest } = await log.head();

  return newest && cursorKind(newest.cursor);
}

/** What a command's or a service's `opened` entry holds of its output: the log's reference. */
const openedWithOutputSchema = z.object({
  node: z.object({
    id: nodeIdSchema,
    kind: z.enum(['command', 'service']),
    outputLog: z.object({ ref: outputRefSchema }),
  }),
});

/**
 * The reference of the output log the node of `channel` kept, read from the channel's first entry:
 * none for a channel with no entry, an agent's or an extension's (whatever it holds), a node that
 * is not the channel's own, or a command whose output was not stored. Only a command or a service
 * exposes a log, and only its own.
 */
export async function outputRefOf(params: {
  log: ChannelLog;
  channel: string;
}): Promise<OutputRef | undefined> {
  const entries = params.log.read('start')[Symbol.asyncIterator]();

  try {
    const first = await entries.next();
    const opened = first.done ? undefined : openedWithOutputSchema.safeParse(first.value);

    if (!opened?.success || opened.data.node.id !== params.channel) return undefined;

    return opened.data.node.outputLog.ref;
  } finally {
    await entries.return?.();
  }
}

/**
 * Refuses a position the channel cannot be asked for, before anything is read: a `tail` over what
 * its kind allows (`tailLimit`: entries on a channel that numbers them, bytes on an output's) and a
 * cursor of the other kind. Which cursor the log holds is for the read to say.
 */
export function checkPosition(params: { from: string; kind: CursorKind }): void {
  const { from, kind } = params;
  const tail = tailCount(from);

  if (tail !== undefined) {
    if (tail <= tailLimit(kind)) return;

    throw new SubscriptionError({
      reason: 'bad_request',
      message: `A tail of ${String(tail)} is more than this channel allows (${String(tailLimit(kind))})`,
    });
  }

  // The request only lets `snapshot` ask for the tree channel, which is numbered.
  if (from === 'start' || from === 'now' || from === 'snapshot') return;

  if (cursorKind(from) === kind) return;

  throw new SubscriptionError({
    reason: 'bad_request',
    message: `The position ${from} is not of the kind this channel counts`,
  });
}

/**
 * Reads what a subscription starting at `from` sends first: all of the channel's log (`start`),
 * nothing (`now`), the last `n` entries (`tail`; on a channel counted in bytes, the entries within
 * the last `n` bytes of its newest), or the entries after the one with the cursor. `count` is how
 * many entries the log held when it was asked, so what a writer tells afterwards can be joined to it
 * by place, and `newest` is the last: they come from the store's `head`, and never from reading.
 * Only the entries that are sent are read, however long the log is (a numbered channel's cursor is
 * its entry's place, so a tail and a cursor say where to begin), and no more than `count` of them: an
 * entry stored while the read goes on is the writer's to tell. What is kept is charged to `budget`
 * (the request's whole read): past it the request is refused, never cut. A cursor no entry has is
 * `cursor_out_of_range`. An aborted `signal` stops the read, which rejects with the abort's reason:
 * a client that left does not make the server read on.
 *
 * What is kept is also held against `pool`, the bytes the conversation's subscriptions may hold,
 * while the read goes on: many requests reading at once cannot hold more than it. `held` is what
 * the selection holds of it when the read ends, for the caller to give back when it has put the
 * entries somewhere it counts them (a failed read gives back its own).
 */
export async function readSelection(params: {
  log: ChannelLog;
  from: string;
  kind: CursorKind;
  budget: { left: number };
  pool: HeldBytes;
  signal?: AbortSignal | undefined;
}): Promise<Selection> {
  const taken = { bytes: 0 };

  try {
    return await readInto({ ...params, taken });
  } catch (caughtError) {
    params.pool.give(taken.bytes);
    throw caughtError;
  }
}

/** The read of `readSelection`, counting in `taken` what it holds of the pool as it goes. */
async function readInto(params: {
  log: ChannelLog;
  from: string;
  kind: CursorKind;
  budget: { left: number };
  pool: HeldBytes;
  signal?: AbortSignal | undefined;
  taken: { bytes: number };
}): Promise<Selection> {
  const { log, from, kind, budget, pool, signal, taken } = params;
  // Asked before anything is read: what the log held then is what the writer's places are joined to.
  const { count, newest } = await log.head();

  if (newest === undefined) {
    throw new ConversationsError({ reason: 'not_found', message: NO_SUCH_CHANNEL });
  }

  const tail = tailCount(from);
  const plan = planOf({ from, kind, count });
  let kept: ChannelEntry[] = [];
  const release = (entry: ChannelEntry) => {
    const size = sizeOf(entry);

    budget.left += size;
    pool.give(size);
    taken.bytes -= size;
  };
  const hold = (entry: ChannelEntry) => {
    holdEntry({ entry, budget, pool, taken });
    kept.push(entry);
  };

  await readPlanned({ log, plan, from, hold, signal });

  if (tail !== undefined && kind === 'byte') {
    const floor = cursorNumber(newest.cursor) - tail;
    const inside = (entry: ChannelEntry) => cursorNumber(entry.cursor) >= floor;

    // Held while the window was not known, then given back: a byte channel's log is a few entries.
    for (const left of kept.filter((entry) => !inside(entry))) release(left);

    kept = kept.filter(inside);
  }

  return {
    entries: kept,
    count,
    newest: { cursor: newest.cursor, type: newest.type },
    held: taken.bytes,
  };
}

/** What to ask the store for, to send what a position wants of a channel that held `count` entries. */
type Plan = {
  /** What to read; none when nothing is to be sent. */
  read: ChannelFrom | undefined;
  /** How many entries from the start of that read are ones the channel held: no more are taken. */
  take: number;
  /** A byte channel's cursor is not an entry's place: the entries through it are read and skipped. */
  skipThrough?: string;
};

/**
 * The read that gives what a subscription at `from` sends first. A numbered channel's cursor is its
 * entry's place, so a tail and a cursor say which entry to begin after, and the store seeks to it. A
 * byte channel's log holds a few entries (the output is in the output store), so it is read from its
 * start and a cursor is found by reading. `cursor_out_of_range` for a cursor that is not an entry's
 * place in a numbered channel.
 */
function planOf(params: { from: string; kind: CursorKind; count: number }): Plan {
  const { from, kind, count } = params;
  const tail = tailCount(from);

  if (from === 'now') return { read: undefined, take: 0 };

  if (kind === 'byte') {
    const skip = from !== 'start' && tail === undefined;

    return { read: 'start', take: count, ...(skip && { skipThrough: from }) };
  }

  if (from === 'start') return { read: 'start', take: count };

  const first =
    tail === undefined ? placeAfter({ cursor: from, count }) : Math.max(0, count - tail);
  const take = count - first;

  if (take === 0) return { read: undefined, take };

  return { read: first === 0 ? 'start' : { after: `s${String(first - 1)}` }, take };
}

/** The place of the entry that follows the one `cursor` names, in a numbered channel of `count`. */
function placeAfter(params: { cursor: string; count: number }): number {
  const { cursor, count } = params;
  const place = cursorKind(cursor) === 'sequence' ? cursorNumber(cursor) : -1;

  if (place < 0 || place >= count) throw cursorOutOfRange(cursor);

  return place + 1;
}

/** Reads what `plan` says, holding each entry that is sent, and refuses a cursor the store does not hold. */
async function readPlanned(params: {
  log: ChannelLog;
  plan: Plan;
  from: string;
  hold: (entry: ChannelEntry) => void;
  signal?: AbortSignal | undefined;
}): Promise<void> {
  const { plan, from } = params;

  if (plan.read === undefined || plan.take === 0) return;

  let passed: boolean;

  try {
    passed = await takeEntries({ ...params, read: plan.read, take: plan.take });
  } catch (caughtError) {
    // The store says a cursor is not its entry's; what a client is told is the subscription's.
    if (caughtError instanceof StoreError && caughtError.reason === 'cursor_out_of_range') {
      throw cursorOutOfRange(from);
    }

    throw caughtError;
  }

  if (!passed) throw cursorOutOfRange(from);
}

/**
 * Holds the first `take` entries of the store's read of `read`, after the one a byte channel's
 * cursor names (`plan.skipThrough`), and stops there: the rest is not read. Whether that entry was
 * reached, which is true when there was none to find.
 */
async function takeEntries(params: {
  log: ChannelLog;
  plan: Plan;
  read: ChannelFrom;
  take: number;
  hold: (entry: ChannelEntry) => void;
  signal?: AbortSignal | undefined;
}): Promise<boolean> {
  const { log, plan, read, take, hold, signal } = params;
  let seen = 0;
  let passed = plan.skipThrough === undefined;

  for await (const entry of log.read(read)) {
    signal?.throwIfAborted();
    seen += 1;

    if (passed) hold(entry);
    else passed = entry.cursor === plan.skipThrough;

    if (seen >= take) break;
  }

  return passed;
}

/** The refusal for a cursor the channel does not hold. */
function cursorOutOfRange(cursor: string): SubscriptionError {
  return new SubscriptionError({
    reason: 'cursor_out_of_range',
    message: `No entry of this channel has the cursor ${cursor}`,
  });
}

/**
 * What `from: snapshot` on the tree channel sends first: the tree as the writer has stored it, as
 * one frame, and no history. `count` is the place after the entry it covers up to, so what the
 * writer told while it was taken, from that entry on, is dropped as already in it, and what comes
 * after is sent. Refuses as `treeSnapshotOf` does.
 */
export async function snapshotSelection(tree: TreeChannelWriter | undefined): Promise<Selection> {
  const snapshot = await treeSnapshotOf(tree);

  return {
    entries: [],
    count: cursorNumber(snapshot.cursor) + 1,
    newest: { cursor: snapshot.cursor, type: SNAPSHOT_EVENT },
    held: 0,
    snapshot,
  };
}

/** The refusal for a request whose history does not fit in what the conversation's subscriptions may hold. */
export function tooMuchHeld(): SubscriptionError {
  return new SubscriptionError({
    reason: 'too_many_subscriptions',
    message:
      'This conversation holds as much for its subscriptions as it may: ask again when one has ended, or subscribe from a cursor or a tail',
  });
}

/** The refusal for a request that would hold more history than one request may. */
export function tooLarge(): SubscriptionError {
  return new SubscriptionError({
    reason: 'bad_request',
    message: `This request would send more than ${String(MAX_SUBSCRIBE_READ_BYTES)} bytes of stored history: subscribe from a cursor or a tail`,
  });
}

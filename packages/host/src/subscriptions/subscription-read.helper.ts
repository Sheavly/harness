import { z } from 'zod';
import type { ChannelEntry, ChannelLog } from '@sheavly/core/store/store.types';
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

/** What a channel's cursors count, from its first entry; none for a channel with no entry. */
export async function kindOf(log: ChannelLog): Promise<CursorKind | undefined> {
  const entries = log.read('start')[Symbol.asyncIterator]();

  try {
    const first = await entries.next();

    return first.done ? undefined : cursorKind(first.value.cursor);
  } finally {
    await entries.return?.();
  }
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
 * Reads the whole log of a channel once, and keeps what a subscription starting at `from` sends
 * first: all of it (`start`), nothing (`now`), the last `n` entries (`tail`; on a channel counted in
 * bytes, the entries within the last `n` bytes of its newest), or the entries after the one with the
 * cursor. `count` is how many entries it held, so what a writer tells afterwards can be joined to it
 * by place; `newest` is the last. What is kept is charged to `budget` (the request's whole read):
 * past it the request is refused, never cut. A cursor no entry has is `cursor_out_of_range`. An
 * aborted `signal` stops the read, which rejects with the abort's reason: a client that left does
 * not make the server read a whole log.
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
  const tail = tailCount(from);
  const afterCursor = from !== 'start' && from !== 'now' && tail === undefined;
  let kept: ChannelEntry[] = [];
  let count = 0;
  let newest: Selection['newest'] | undefined;
  let passed = !afterCursor;

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

  // A tail on a numbered channel holds only its last `n` entries, so the oldest goes (and is no
  // longer charged) before the next is taken: a tail is never refused for history it does not send.
  const limit = kind === 'sequence' ? tail : undefined;
  const keep = (entry: ChannelEntry) => {
    if (limit !== undefined && kept.length >= limit) {
      const dropped = kept.shift();

      if (dropped) release(dropped);
    }

    hold(entry);
  };

  for await (const entry of log.read('start')) {
    signal?.throwIfAborted();
    newest = { cursor: entry.cursor, type: entry.type };
    count += 1;

    if (from === 'now') continue;

    if (passed) keep(entry);
    else passed = entry.cursor === from;
  }

  if (newest === undefined) {
    throw new ConversationsError({ reason: 'not_found', message: NO_SUCH_CHANNEL });
  }

  if (!passed) {
    throw new SubscriptionError({
      reason: 'cursor_out_of_range',
      message: `No entry of this channel has the cursor ${from}`,
    });
  }

  if (tail !== undefined && kind === 'byte') {
    const floor = cursorNumber(newest.cursor) - tail;
    const inside = (entry: ChannelEntry) => cursorNumber(entry.cursor) >= floor;

    // Held while the window was not known (the newest entry is the last one read), then given back.
    for (const left of kept.filter((entry) => !inside(entry))) release(left);

    kept = kept.filter(inside);
  }

  return { entries: kept, count, newest, held: taken.bytes };
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

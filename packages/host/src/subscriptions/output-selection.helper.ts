import { now } from '@sheavly/core/clock/clock.helper';
import { OutputError } from '@sheavly/core/errors/output.errors';
import type { OutputReader } from '@sheavly/core/output/output.types';
import type { ChannelEntry, ChannelLog } from '@sheavly/core/store/store.types';
import { MAX_OUTPUT_CHUNK_BYTES } from '@sheavly/protocol/channel/channel.constants';
import { cursorNumber } from '@sheavly/protocol/channel/channel.utils';
import type { OutputRef } from '@sheavly/protocol/output/output.types';
import { tailCount } from '@sheavly/protocol/subscription/subscription.utils';
import { ConversationsError } from '../errors/conversations.errors.js';
import { SubscriptionError } from '../errors/subscription.errors.js';
import type { HeldBytes } from './held-bytes.service.js';
import { closedAt, outputCursor, outputEntry, utf8Bytes } from './output-chunks.utils.js';
import { holdEntry, tooLarge } from './subscription-read.helper.js';
import { MAX_OUTPUT_BYTES_PER_JSON_CHAR, NO_SUCH_CHANNEL } from './subscriptions.constants.js';
import type { Selection } from './subscriptions.types.js';

/** What the store holds of a command's channel: its first entry, its last once it has ended, and how many. */
type Stored = { opened?: ChannelEntry; closed?: ChannelEntry; count: number };

/** Where the output a request asks for starts, and which stored entries go with it. */
type Window = { offset: number; withOpened: boolean; now: boolean };

/** What every read of the output store that fails is told as: the output could not be read. */
async function readable<T>(work: () => Promise<T>): Promise<T> {
  try {
    return await work();
  } catch (caughtError) {
    if (!(caughtError instanceof OutputError)) throw caughtError;

    throw new ConversationsError({
      reason: 'storage_failed',
      message: `The output of this command could not be read (${caughtError.message})`,
      cause: caughtError,
    });
  }
}

/** The stored entries of a command's channel: `opened`, and `closed` once the node has ended. */
async function storedEntries(params: {
  log: ChannelLog;
  signal?: AbortSignal | undefined;
}): Promise<Stored> {
  const stored: Stored = { count: 0 };

  for await (const entry of params.log.read('start')) {
    params.signal?.throwIfAborted();
    stored.count += 1;

    if (entry.type === 'opened') stored.opened ??= entry;
    else if (entry.type === 'closed') stored.closed = entry;
  }

  if (stored.count === 0) {
    throw new ConversationsError({ reason: 'not_found', message: NO_SUCH_CHANNEL });
  }

  return stored;
}

/**
 * Where the output starts for a request at `from`, with `total` bytes stored now. A byte cursor
 * means the bytes from there, so the entry that opened the channel is not sent again: only `start`
 * has it, and a `tail` that reaches the first byte. One past the end is `cursor_out_of_range`.
 */
function windowOf(params: { from: string; total: number }): Window {
  const { from, total } = params;
  const tail = tailCount(from);

  if (from === 'now') return { offset: total, withOpened: false, now: true };

  if (from === 'start') return { offset: 0, withOpened: true, now: false };

  if (tail !== undefined) {
    const offset = Math.max(0, total - tail);

    return { offset, withOpened: offset === 0, now: false };
  }

  const offset = cursorNumber(from);

  if (offset > total) {
    throw new SubscriptionError({
      reason: 'cursor_out_of_range',
      message: `The output has ${String(total)} bytes: no position ${from}`,
    });
  }

  return { offset, withOpened: false, now: false };
}

/**
 * Reads the output from `from` to `total` as entries of at most `MAX_OUTPUT_CHUNK_BYTES`, each
 * holding itself against the request's budget and the conversation's pool (`hold`). Returns the
 * offset it reached: after the last entry, or at `total` when what was left was only the end of a
 * character the position began inside. The entries are stamped `at`.
 */
async function readChunks(params: {
  channel: string;
  outputs: OutputReader;
  ref: OutputRef;
  from: number;
  total: number;
  at: number;
  hold: (entry: ChannelEntry) => void;
  signal?: AbortSignal | undefined;
}): Promise<number> {
  const { channel, outputs, ref, total, at, hold, signal } = params;
  let offset = params.from;

  while (offset < total) {
    signal?.throwIfAborted();

    const maxBytes = Math.min(MAX_OUTPUT_CHUNK_BYTES, total - offset);
    const range = await readable(() => outputs.read({ ref, offset, maxBytes }));

    if (range.text === '') return total;

    hold(outputEntry({ channel, offset: range.offset, text: range.text, at }));
    offset = range.offset + utf8Bytes(range.text);
  }

  return offset;
}

/**
 * What a subscription to a command's or a service's channel starts with, for the position `from`:
 * the stored `opened` entry (for `start`, or a tail that reaches the first byte), the output from
 * the output store as `output` entries, and the stored `closed` entry once the node has ended, with
 * its cursor at the end of the output: a node that was lost has none of its own, though what it
 * printed is there to read. `now` sends nothing and says where the output stands, `newest`.
 *
 * `outputEnd` is the offset the live output joins at, and `count` the stored entries, so the writer's
 * own `closed` event is joined as for any channel. What is kept is charged as for any history
 * (`budget`, the request's read; `pool`, what the conversation's subscriptions hold): past it the
 * request is refused, never cut. The output is read after the capture was followed, so what it
 * missed is told, and what it holds that was told is dropped by offset.
 */
export async function readOutputSelection(params: {
  channel: string;
  log: ChannelLog;
  from: string;
  ref: OutputRef;
  outputs: OutputReader;
  budget: { left: number };
  pool: HeldBytes;
  signal?: AbortSignal | undefined;
}): Promise<Selection> {
  const taken = { bytes: 0 };

  try {
    return await readOutput({ ...params, taken });
  } catch (caughtError) {
    params.pool.give(taken.bytes);
    throw caughtError;
  }
}

/** The read of `readOutputSelection`, counting in `taken` what it holds of the pool as it goes. */
async function readOutput(params: {
  channel: string;
  log: ChannelLog;
  from: string;
  ref: OutputRef;
  outputs: OutputReader;
  budget: { left: number };
  pool: HeldBytes;
  signal?: AbortSignal | undefined;
  taken: { bytes: number };
}): Promise<Selection> {
  const { channel, log, from, ref, outputs, budget, pool, signal, taken } = params;
  const stored = await storedEntries({ log, signal });
  const total = (await readable(() => outputs.log(ref))).bytes;
  const window = windowOf({ from, total });

  // Refused before it reads, when even the least it could take (a character of three bytes is one of
  // JSON) is over the request's budget: not after reading all of it for nothing.
  if (!window.now && (total - window.offset) / MAX_OUTPUT_BYTES_PER_JSON_CHAR > budget.left) {
    throw tooLarge();
  }

  const entries: ChannelEntry[] = [];
  const hold = (entry: ChannelEntry) => {
    holdEntry({ entry, budget, pool, taken });
    entries.push(entry);
  };

  if (window.withOpened && stored.opened) hold(stored.opened);

  // The output does not record when a byte was printed: what a finished command printed is stamped
  // with when it ended, so no entry is later than the `closed` one that follows it, and what a
  // running one has printed so far with now.
  const at = stored.closed?.at ?? now();
  const end = window.now
    ? total
    : await readChunks({ channel, outputs, ref, from: window.offset, total, at, hold, signal });
  const reached = Math.max(total, end);

  if (stored.closed) hold(closedAt({ entry: stored.closed, end: reached }));

  return {
    entries,
    count: stored.count,
    newest: {
      cursor: outputCursor(
        stored.closed ? Math.max(reached, cursorNumber(stored.closed.cursor)) : reached,
      ),
      type: stored.closed ? 'closed' : 'opened',
    },
    held: taken.bytes,
    outputEnd: end,
  };
}

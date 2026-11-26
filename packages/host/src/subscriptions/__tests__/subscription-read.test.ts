import { describe, expect, it } from 'vitest';
import { StoreError } from '@sheavly/core/errors/store.errors';
import type { ChannelEntry, ChannelLog } from '@sheavly/core/store/store.types';
import type { CursorKind } from '@sheavly/protocol/channel/channel.types';
import { MAX_TAIL, MAX_TAIL_BYTES } from '@sheavly/protocol/subscription/subscription.constants';
import { HeldBytes } from '../held-bytes.service.js';
import { checkPosition, kindOf, readSelection } from '../subscription-read.helper.js';

/**
 * A log holding `entries`, which a subscription only reads, as a store reads one: from the start, a
 * tail or after a cursor it holds. `reads` is given each entry the log hands out, in order, so a
 * test can say which of them a subscription touched. `told` is what `head` says it holds, when that
 * is less than `entries`: the entries after it were stored after it was asked.
 */
const logOf = (
  entries: ChannelEntry[],
  options: { reads?: string[]; told?: number } = {},
): ChannelLog => ({
  append: () => Promise.resolve(),
  head: () => {
    const held = entries.slice(0, options.told ?? entries.length);
    const newest = held.at(-1);

    return Promise.resolve({
      count: held.length,
      newest: newest && { channel: newest.channel, cursor: newest.cursor, type: newest.type },
    });
  },
  async *read(from = 'start') {
    let begin = 0;

    if (from !== 'start' && 'tail' in from) begin = Math.max(0, entries.length - from.tail);

    if (from !== 'start' && 'after' in from) {
      const at = entries.findIndex((each) => each.cursor === from.after);

      if (at < 0) throw new StoreError({ reason: 'cursor_out_of_range', message: 'not held' });

      begin = at + 1;
    }

    for (const each of entries.slice(begin)) {
      options.reads?.push(each.cursor);
      yield each;
    }
  },
});

/** An entry at `cursor`, with `pad` characters of text so its size is known to a test. */
const entry = (cursor: string, pad = 0): ChannelEntry => ({
  channel: 'a',
  cursor,
  at: 1,
  type: cursor === 's0' || cursor === 'b0' ? 'opened' : 'updated',
  pad: 'x'.repeat(pad),
});

const sizeOf = (each: ChannelEntry) => JSON.stringify(each).length;
const cursors = (entries: ChannelEntry[]) => entries.map((each) => each.cursor);

const FOUR = ['s0', 's1', 's2', 's3'].map((cursor) => entry(cursor, 50));

/** A budget and a pool no test comes near, unless it says otherwise. */
const ROOM = 1_000_000;

const read = (params: {
  log: ChannelLog;
  from: string;
  kind?: CursorKind;
  budget?: { left: number };
  pool?: HeldBytes;
}) =>
  readSelection({
    log: params.log,
    from: params.from,
    kind: params.kind ?? 'sequence',
    budget: params.budget ?? { left: ROOM },
    pool: params.pool ?? new HeldBytes(ROOM),
  });

const select = (params: { from: string; budget?: number; entries?: ChannelEntry[] }) =>
  read({
    log: logOf(params.entries ?? FOUR),
    from: params.from,
    budget: { left: params.budget ?? ROOM },
  });

describe('what a channel’s cursors count', () => {
  it('is read from what the channel holds, without reading an entry', async () => {
    const reads: string[] = [];

    expect(await kindOf(logOf([entry('s0'), entry('s1')], { reads }))).toBe('sequence');
    expect(await kindOf(logOf([entry('b0')], { reads }))).toBe('byte');
    expect(reads).toEqual([]);
  });

  it('is nothing for a channel that holds nothing', async () => {
    expect(await kindOf(logOf([]))).toBeUndefined();
  });
});

describe('a position checked before anything is read', () => {
  it.each([
    ['start', 'sequence'],
    ['now', 'byte'],
    ['s7', 'sequence'],
    ['b7', 'byte'],
    [`tail:${String(MAX_TAIL)}`, 'sequence'],
    [`tail:${String(MAX_TAIL_BYTES)}`, 'byte'],
  ] as const)('accepts %s on a %s channel', (from, kind) => {
    expect(() => {
      checkPosition({ from, kind });
    }).not.toThrow();
  });

  it.each([
    ['a tail over what a numbered channel allows', `tail:${String(MAX_TAIL + 1)}`, 'sequence'],
    ['a tail over what a byte channel allows', `tail:${String(MAX_TAIL_BYTES + 1)}`, 'byte'],
    ['a byte cursor on a numbered channel', 'b3', 'sequence'],
    ['a sequence cursor on a byte channel', 's3', 'byte'],
  ] as const)('refuses %s as a bad request', (_name, from, kind) => {
    expect(() => {
      checkPosition({ from, kind });
    }).toThrow(expect.objectContaining({ reason: 'bad_request' }));
  });
});

describe('what a subscription sends first', () => {
  it('is everything from the start, and where the log stood', async () => {
    const selection = await select({ from: 'start' });

    expect(cursors(selection.entries)).toEqual(['s0', 's1', 's2', 's3']);
    expect(selection.count).toBe(4);
    expect(selection.newest.cursor).toBe('s3');
  });

  it('is nothing at now, but still where the log stood', async () => {
    const selection = await select({ from: 'now' });

    expect(selection.entries).toEqual([]);
    expect(selection.count).toBe(4);
    expect(selection.newest.cursor).toBe('s3');
  });

  it.each([
    ['tail:1', ['s3']],
    ['tail:3', ['s1', 's2', 's3']],
    ['tail:99', ['s0', 's1', 's2', 's3']],
    ['s1', ['s2', 's3']],
    ['s3', []],
  ])('is %s: %j', async (from, expected) => {
    expect(cursors((await select({ from })).entries)).toEqual(expected);
  });

  it('is the entries within the last n bytes, for a channel counted in bytes', async () => {
    const entries = [entry('b0'), entry('b50'), entry('b100')];
    const bytes = (from: string) => read({ log: logOf(entries), from, kind: 'byte' });

    expect(cursors((await bytes('tail:60')).entries)).toEqual(['b50', 'b100']);
    expect(cursors((await bytes('tail:1')).entries)).toEqual(['b100']);
    expect(cursors((await bytes('tail:65536')).entries)).toEqual(['b0', 'b50', 'b100']);
  });

  it('refuses a cursor no entry has, and never starts at the nearest', async () => {
    await expect(select({ from: 's9' })).rejects.toMatchObject({ reason: 'cursor_out_of_range' });
    await expect(select({ from: 's4' })).rejects.toMatchObject({ reason: 'cursor_out_of_range' });
  });

  it('says a channel that holds nothing is not there', async () => {
    await expect(select({ from: 'start', entries: [] })).rejects.toMatchObject({
      reason: 'not_found',
    });
  });
});

describe('what a read touches of a long channel', () => {
  const LONG = Array.from({ length: 50 }, (_, n) => entry(`s${String(n)}`));
  const touched = async (from: string) => {
    const reads: string[] = [];

    await read({ log: logOf(LONG, { reads }), from });

    return reads;
  };

  it('reads only the entries it sends, for a tail and for a cursor, wherever it begins', async () => {
    expect(await touched('tail:3')).toEqual(['s47', 's48', 's49']);
    expect(await touched('s46')).toEqual(['s47', 's48', 's49']);
    expect(await touched('s0')).toHaveLength(49);
    expect(await touched('tail:99')).toHaveLength(50);
    // What sends nothing reads nothing: where the log stands is what the store said.
    expect(await touched('tail:0')).toEqual([]);
    expect(await touched('now')).toEqual([]);
    expect(await touched('s49')).toEqual([]);
  });

  it('sends what the log held when it was asked, and leaves what was stored after to the writer', async () => {
    // The log says it holds four: two more were stored while the read went on, and the writer
    // tells those, so a read that sent them too would send them twice.
    const six = [...FOUR, entry('s4', 50), entry('s5', 50)];

    for (const [from, expected] of [
      ['start', ['s0', 's1', 's2', 's3']],
      ['tail:2', ['s2', 's3']],
      ['s1', ['s2', 's3']],
      ['s3', []],
    ] as const) {
      const selection = await read({ log: logOf(six, { told: 4 }), from });

      expect(cursors(selection.entries)).toEqual(expected);
      expect(selection.count).toBe(4);
      expect(selection.newest.cursor).toBe('s3');
    }
  });

  it('refuses a cursor that is no entry’s place before it reads anything', async () => {
    const reads: string[] = [];

    for (const from of ['s50', 's99', 'b3']) {
      await expect(read({ log: logOf(LONG, { reads }), from })).rejects.toMatchObject({
        reason: 'cursor_out_of_range',
      });
    }

    expect(reads).toEqual([]);
  });

  it('tells a cursor the store does not hold as the subscription’s refusal, and any other failure as it is', async () => {
    const failing = (reason: 'cursor_out_of_range' | 'failed'): ChannelLog => ({
      ...logOf(LONG),
      read: () => {
        throw new StoreError({ reason, message: 'stored file is damaged' });
      },
    });

    await expect(read({ log: failing('cursor_out_of_range'), from: 's10' })).rejects.toMatchObject({
      name: 'SubscriptionError',
      reason: 'cursor_out_of_range',
    });
    await expect(read({ log: failing('failed'), from: 's10' })).rejects.toMatchObject({
      name: 'StoreError',
      reason: 'failed',
    });
  });

  it('finds the cursor of a byte channel by reading its few entries', async () => {
    const entries = [entry('b0'), entry('b50'), entry('b100')];
    const bytes = (from: string) => read({ log: logOf(entries), from, kind: 'byte' });

    expect(cursors((await bytes('b50')).entries)).toEqual(['b100']);
    expect(cursors((await bytes('b100')).entries)).toEqual([]);
    await expect(bytes('b7')).rejects.toMatchObject({ reason: 'cursor_out_of_range' });
  });
});

describe('the most one request reads', () => {
  const sizes = FOUR.map(sizeOf);
  const total = sizes.reduce((sum, size) => sum + size, 0);

  it('refuses a request whose history would be more, as a bad request, never cut', async () => {
    await expect(select({ from: 'start', budget: total - 1 })).rejects.toMatchObject({
      reason: 'bad_request',
    });
    expect(cursors((await select({ from: 'start', budget: total })).entries)).toHaveLength(4);
  });

  it('charges what is sent, and not the older entries a tail leaves out', async () => {
    // Just enough for the last two: the first two are read and left out, and never charged for.
    const budget = { left: (sizes[2] ?? 0) + (sizes[3] ?? 0) };
    const selection = await read({ log: logOf(FOUR), from: 'tail:2', budget });

    expect(cursors(selection.entries)).toEqual(['s2', 's3']);
    expect(budget.left).toBe(0);
  });

  it('shares one budget between the channels of a request', async () => {
    const budget = { left: total };
    const readAll = () => read({ log: logOf(FOUR), from: 'start', budget });

    await readAll();

    expect(budget.left).toBe(0);
    await expect(readAll()).rejects.toMatchObject({ reason: 'bad_request' });
  });

  it('does not charge for what a subscription at now sends, which is nothing', async () => {
    const budget = { left: 1 };

    await read({ log: logOf(FOUR), from: 'now', budget });

    expect(budget.left).toBe(1);
  });
});

describe('what a read holds of the conversation’s pool while it goes on', () => {
  const sizes = FOUR.map(sizeOf);
  const total = sizes.reduce((sum, size) => sum + size, 0);

  /** Whether `pool` has `bytes` left: it takes them if it does, so ask once per pool. */
  const hasRoom = (params: { pool: HeldBytes; bytes: number }) => params.pool.take(params.bytes);

  it('holds exactly what the selection keeps, which is what it reports', async () => {
    const pool = new HeldBytes(total + 10);
    const selection = await read({ log: logOf(FOUR), from: 'start', pool });

    expect(selection.held).toBe(total);
    // Only the 10 bytes that were left are left.
    expect(hasRoom({ pool, bytes: 11 })).toBe(false);
    expect(hasRoom({ pool, bytes: 10 })).toBe(true);
  });

  it('refuses history the pool cannot hold, as one more than the conversation serves, holding nothing', async () => {
    const pool = new HeldBytes(total - 1);

    await expect(read({ log: logOf(FOUR), from: 'start', pool })).rejects.toMatchObject({
      reason: 'too_many_subscriptions',
    });
    // Everything it had taken before it failed was given back.
    expect(hasRoom({ pool, bytes: total - 1 })).toBe(true);
  });

  it('holds only what a tail sends, since it reads no more', async () => {
    const pool = new HeldBytes((sizes[2] ?? 0) + (sizes[3] ?? 0));
    const selection = await read({ log: logOf(FOUR), from: 'tail:2', pool });

    expect(cursors(selection.entries)).toEqual(['s2', 's3']);
    expect(selection.held).toBe((sizes[2] ?? 0) + (sizes[3] ?? 0));
    expect(hasRoom({ pool, bytes: 1 })).toBe(false);
  });

  it('holds only what a byte tail keeps, giving back what its window leaves out', async () => {
    const entries = [entry('b0', 40), entry('b50', 40), entry('b100', 40)];
    const pool = new HeldBytes(1_000);
    const selection = await read({ log: logOf(entries), from: 'tail:60', kind: 'byte', pool });
    const kept = selection.entries.reduce((sum, each) => sum + sizeOf(each), 0);

    expect(cursors(selection.entries)).toEqual(['b50', 'b100']);
    expect(selection.held).toBe(kept);
    // The pool has taken exactly what the selection holds.
    expect(hasRoom({ pool, bytes: 1_000 - kept })).toBe(true);
    expect(hasRoom({ pool, bytes: 1 })).toBe(false);
  });

  it('holds nothing for a position that sends nothing, however large the newest entry is', async () => {
    const pool = new HeldBytes(1);
    const entries = [entry('s0'), entry('s1', 100_000)];
    const selection = await read({ log: logOf(entries), from: 'now', pool });

    expect(selection.held).toBe(0);
    // Only where the log stood is kept, not the entry, which the pool does not count.
    expect(selection.newest).toEqual({ cursor: 's1', type: 'updated' });
    expect(hasRoom({ pool, bytes: 1 })).toBe(true);
  });

  it('holds nothing of a log whose cursor it never finds, and says so', async () => {
    const pool = new HeldBytes(total);

    await expect(read({ log: logOf(FOUR), from: 's9', pool })).rejects.toMatchObject({
      reason: 'cursor_out_of_range',
    });
    // The entries before a cursor are not held, so a log that does not have it held none.
    expect(hasRoom({ pool, bytes: total })).toBe(true);
  });
});

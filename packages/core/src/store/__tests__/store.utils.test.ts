import { describe, expect, it } from 'vitest';
import { StoreError } from '../../errors/store.errors.js';
import { MAX_CHANNEL_ENTRY_CHARS } from '@sheavly/protocol/channel/channel.constants';
import { MAX_TAIL } from '@sheavly/protocol/subscription/subscription.constants';
import {
  assertChannelName,
  channelAppendEntry,
  channelAppendProblem,
  channelFromProblem,
  storedChannelEntry,
  toStoreError,
} from '../store.utils.js';

/** Why `entry` is not kept, or `undefined` when it is. */
function problemOf(entry: Parameters<typeof storedChannelEntry>[0]): string | undefined {
  const stored = storedChannelEntry(entry);

  return 'problem' in stored ? stored.problem : undefined;
}

/** An entry wrong in a way its type does not allow, as a caller can still send one at run time. */
const past = (entry: Record<string, unknown>): never => entry as never;

/** A whole entry of channel `channel`, as a store is given one. */
const whole = (channel: string, type: string, cursor: string) => ({
  channel,
  type,
  cursor,
  at: 1,
  node: { id: channel },
});

/** The head of an entry of channel `channel`: its type and cursor, the rest is the store's to ignore. */
const head = (channel: string, type: string, cursor: string) => ({ channel, type, cursor });

describe('channelAppendProblem', () => {
  it.each([
    ['a node channel opens at s0', head('main', 'opened', 's0'), undefined],
    ['a command channel opens at b0', head('t1', 'opened', 'b0'), undefined],
    ['the tree opens at s0', head('tree', 'opened', 's0'), undefined],
  ])('lets %s', (_name, entry, last) => {
    expect(channelAppendProblem({ entry, last })).toBeUndefined();
  });

  it.each([
    ['not opened first', head('main', 'updated', 's0')],
    ['opened at a later cursor', head('main', 'opened', 's3')],
    ['a tree counted in bytes', head('tree', 'opened', 'b0')],
    ['a name that is not a node id or the tree', head('Main/../x', 'opened', 's0')],
    ['something that is not a cursor', head('main', 'opened', '0')],
  ])('refuses a channel that starts with %s', (_name, entry) => {
    expect(channelAppendProblem({ entry, last: undefined })).toEqual(expect.any(String));
  });

  it.each([
    ['the next in a sequence', head('main', 'updated', 's1'), head('main', 'opened', 's0')],
    ['the end after an update', head('main', 'closed', 's2'), head('main', 'updated', 's1')],
    ['more bytes', head('t1', 'closed', 'b40'), head('t1', 'opened', 'b0')],
    ['the same offset again', head('t1', 'closed', 'b0'), head('t1', 'opened', 'b0')],
  ])('lets %s follow', (_name, entry, last) => {
    expect(channelAppendProblem({ entry, last })).toBeUndefined();
  });

  it.each([
    ['a gap', head('main', 'updated', 's2'), head('main', 'opened', 's0')],
    ['a repeat', head('main', 'updated', 's0'), head('main', 'opened', 's0')],
    ['a second opened', head('main', 'opened', 's1'), head('main', 'opened', 's0')],
    ['anything after closed', head('main', 'updated', 's2'), head('main', 'closed', 's1')],
    ['another channel’s entry', head('other', 'updated', 's1'), head('main', 'opened', 's0')],
    ['a cursor of the other kind', head('main', 'updated', 'b1'), head('main', 'opened', 's0')],
    ['an offset that goes back', head('t1', 'updated', 'b3'), head('t1', 'updated', 'b9')],
  ])('refuses %s', (_name, entry, last) => {
    expect(channelAppendProblem({ entry, last })).toEqual(expect.any(String));
  });

  it('names the channel and the cursor, never anything an entry holds', () => {
    // A real entry holds more than a head: whatever its type adds.
    const entry = { ...head('main', 'updated', 's9'), secret: 'hunter2' };
    const message = channelAppendProblem({ entry, last: head('main', 'opened', 's0') });

    expect(message).toContain('main');
    expect(message).toContain('s9');
    expect(message).not.toContain('hunter2');
  });
});

describe('channelFromProblem', () => {
  it.each(['start', { tail: 0 }, { tail: 5 }, { after: 's3' }] as const)(
    'lets a read start at %j',
    (from) => {
      expect(channelFromProblem(from)).toBeUndefined();
    },
  );

  it.each([
    { tail: -1 },
    { tail: 1.5 },
    { tail: Number.NaN },
    { tail: Number.POSITIVE_INFINITY },
    { tail: MAX_TAIL + 1 },
  ])('refuses a tail of %j', (from) => {
    expect(channelFromProblem(from)).toEqual(expect.any(String));
  });

  it('lets a tail go up to the most a subscription may ask for', () => {
    expect(channelFromProblem({ tail: MAX_TAIL })).toBeUndefined();
  });

  it.each(['', 'x', '3', 'S1', 's01', 'b-1'])(
    'refuses an after of %j, which is not a cursor',
    (after) => {
      expect(channelFromProblem({ after })).toEqual(expect.any(String));
    },
  );
});

describe('storedChannelEntry', () => {
  it('lets a whole entry, with whatever else its type holds', () => {
    expect(problemOf({ ...whole('main', 'updated', 's1'), more: [1, 2] })).toBeUndefined();
  });

  it.each([
    ['a timestamp that is not one', { ...whole('main', 'updated', 's1'), at: 'nope' }],
    ['a type longer than a name may be', whole('main', 'x'.repeat(200), 's1')],
    ['an empty type', whole('main', '', 's1')],
    ['a cursor that is not one', whole('main', 'updated', '1')],
    ['a channel that is not a node id', whole('Main', 'updated', 's1')],
    ['no channel', { type: 'updated', cursor: 's1', at: 1 }],
  ])('refuses %s', (_name, entry) => {
    // Typed as the store takes it; the check is for what a caller sends past the types.
    expect(problemOf(entry as never)).toEqual(expect.any(String));
  });

  it('refuses an entry over the most a stored line may be, and lets one at it', () => {
    const base = whole('main', 'updated', 's1');
    const room = MAX_CHANNEL_ENTRY_CHARS - JSON.stringify({ ...base, pad: '' }).length;

    expect(problemOf({ ...base, pad: 'x'.repeat(room) })).toBeUndefined();
    expect(problemOf({ ...base, pad: 'x'.repeat(room + 1) })).toEqual(expect.any(String));
  });

  it('refuses an entry that is not JSON, and does not show what it holds', () => {
    const message = problemOf({ ...whole('main', 'updated', 's1'), big: 10n });

    expect(message).toEqual(expect.any(String));
    expect(message).not.toContain('10');
  });

  it('checks the text that is stored, so a toJSON cannot make the line differ from the entry', () => {
    // As an object this has a channel, a cursor, a type and a time; as the line a store writes it
    // is `{"hello":"x"}`, which a read would refuse, so the entry is refused.
    const entry = { ...whole('main', 'updated', 's1'), toJSON: () => ({ hello: 'x' }) };

    expect(problemOf(entry)).toEqual(expect.any(String));
    expect(problemOf({ ...whole('main', 'updated', 's1'), toJSON: () => undefined })).toEqual(
      expect.any(String),
    );
  });

  it('keeps the entry as the JSON a store writes: a plain copy, whatever the caller’s object does', () => {
    const entry = {
      ...whole('main', 'updated', 's1'),
      toJSON: () => whole('main', 'updated', 's7'),
    };
    const stored = storedChannelEntry(entry);

    expect(stored).toEqual({ entry: whole('main', 'updated', 's7') });
    expect(stored).not.toHaveProperty('entry.toJSON');
  });

  it('does not quote a channel name it has not validated', () => {
    const message = problemOf(past({ ...whole('Evil/../name', 'updated', 's1') }));

    expect(message).not.toContain('Evil');
  });

  it('never quotes what an entry holds', () => {
    const message = problemOf(past({ ...whole('main', 'updated', 's1'), at: 'hunter2' }));

    expect(message).not.toContain('hunter2');
  });
});

describe('channelAppendEntry', () => {
  const opened = whole('main', 'opened', 's0');
  const last = { channel: 'main', type: 'opened', cursor: 's0' };

  it('is the entry to keep for one that can come next', () => {
    const next = whole('main', 'updated', 's1');

    expect(channelAppendEntry({ entry: next, channel: 'main', last })).toEqual({ entry: next });
    expect(channelAppendEntry({ entry: opened, channel: 'main', last: undefined })).toEqual({
      entry: opened,
    });
  });

  it('is invalid for an entry the store could not read back, before anything else about it', () => {
    const entry = past({ ...whole('main', 'updated', 's9'), at: 'nope' });

    expect(channelAppendEntry({ entry, channel: 'main', last })).toMatchObject({
      error: { name: 'StoreError', reason: 'invalid' },
    });
  });

  it.each([
    ['a gap', whole('main', 'updated', 's5'), 'main'],
    ['another channel’s entry', whole('other', 'updated', 's1'), 'main'],
  ])('is out of order for %s', (_name, entry, channel) => {
    expect(channelAppendEntry({ entry, channel, last })).toMatchObject({
      error: { reason: 'out_of_order' },
    });
  });

  it('checks the order of the entry that is kept, so a toJSON cannot pass at one cursor and be stored at another', () => {
    // As an object this is the next entry, s1; as the line a store writes it is s7, a gap.
    const entry = {
      ...whole('main', 'updated', 's1'),
      toJSON: () => whole('main', 'updated', 's7'),
    };

    expect(channelAppendEntry({ entry, channel: 'main', last })).toMatchObject({
      error: { reason: 'out_of_order' },
    });
  });
});

describe('assertChannelName', () => {
  it.each(['main', 'tree', 't1', 'a-3f2c_x'])('lets %s', (channel) => {
    expect(() => assertChannelName(channel)).not.toThrow();
  });

  it.each(['', '../x', 'Main', 'a/b', 'a\\b', 'x'.repeat(200)])('refuses %j', (channel) => {
    expect(() => assertChannelName(channel)).toThrow(/node id or is the tree/);
  });
});

describe('toStoreError', () => {
  it('keeps an error a store already raised', () => {
    const raised = new StoreError({ reason: 'out_of_order', message: 'Expected seq 3' });

    expect(toStoreError({ error: raised, message: 'Could not write' })).toBe(raised);
  });

  it('wraps any other error, keeping it as the cause', () => {
    const disk = new Error('ENOSPC');
    const wrapped = toStoreError({ error: disk, message: 'Could not write' });

    expect(wrapped).toBeInstanceOf(StoreError);
    expect(wrapped).toMatchObject({ reason: 'failed', message: 'Could not write', cause: disk });
  });

  it('wraps a thrown value that is not an error', () => {
    expect(toStoreError({ error: 'boom', message: 'Could not write' })).toMatchObject({
      reason: 'failed',
      cause: 'boom',
    });
  });
});

import { describe, expect, it } from 'vitest';
import { MAX_NODE_ERROR_CHARS } from '../../node/node.constants.js';
import { NODE_END_STATES, NODE_STATES, STATUS_TABLE } from '../../status/status.constants.js';
import { MAX_ENTRY_TYPE_CHARS } from '../channel.constants.js';
import {
  channelBoundarySchema,
  channelEntrySchema,
  channelLogSchema,
} from '../channel.validator.js';
import { byteCursorSchema, cursorSchema, sequenceCursorSchema } from '../cursor.validator.js';

const AGENT = { kind: 'agent', id: 'agent-1', title: 'Main', state: 'running', startedAt: 1 };
const COMMAND = {
  kind: 'command',
  id: 't1',
  title: 'npm test',
  state: 'running',
  startedAt: 1,
  command: 'npm test',
  description: 'tests',
  output: '',
};
const NOTES = {
  kind: 'notes.sync',
  id: 'n1',
  title: 'Sync',
  state: 'running',
  startedAt: 1,
  version: 1,
  data: {},
  text: 'Syncing',
};

/** An `opened` entry of `node`'s channel. */
const opened = (node: { id: string }, cursor: string, more: object = {}) => ({
  channel: node.id,
  cursor,
  at: 1,
  type: 'opened',
  node,
  ...more,
});

const accepts = (value: unknown) => channelBoundarySchema.safeParse(value).success;

describe('a cursor', () => {
  it.each(['s0', 's12', 's999999999999999', 'b0', 'b4096', 'b999999999999999'])(
    'accepts %s',
    (cursor) => {
      expect(cursorSchema.safeParse(cursor).success).toBe(true);
    },
  );

  it.each([
    ['empty', ''],
    ['a letter alone', 's'],
    ['a bare number', '12'],
    ['a negative one', 's-1'],
    ['one with a leading zero', 's01'],
    ['one in capitals', 'S1'],
    ['one that is not a whole number', 's1.5'],
    ['one with a space', 's 1'],
    ['one of another kind', 'x5'],
    ['one over fifteen digits', 's1000000000000000'],
  ])('refuses %s', (_name, cursor) => {
    expect(cursorSchema.safeParse(cursor).success).toBe(false);
  });

  it('is of one kind or the other: a sequence is not a byte offset', () => {
    expect(sequenceCursorSchema.safeParse('s3').success).toBe(true);
    expect(sequenceCursorSchema.safeParse('b3').success).toBe(false);
    expect(byteCursorSchema.safeParse('b3').success).toBe(true);
    expect(byteCursorSchema.safeParse('s3').success).toBe(false);
  });
});

describe('the opened entry of a node channel', () => {
  it.each([
    ['an agent starts at a sequence', AGENT, 's0', true],
    ['an agent does not start at a byte offset', AGENT, 'b0', false],
    ['a command starts at a byte offset', COMMAND, 'b0', true],
    ['a command does not start at a sequence', COMMAND, 's0', false],
    ['a kind an extension adds may start at a sequence', NOTES, 's0', true],
    ['a kind an extension adds may start at a byte offset', NOTES, 'b0', true],
    ['an agent starts at the start, not at 5', AGENT, 's5', false],
    ['a command starts at the start, not at 5', COMMAND, 'b5', false],
  ])('%s', (_name, node, cursor, ok) => {
    expect(accepts(opened(node, cursor))).toBe(ok);
  });

  it('is of the node whose channel it opens', () => {
    expect(accepts({ ...opened(AGENT, 's0'), channel: 'agent-2' })).toBe(false);
  });

  it('says where the parent stood, for a node a parent started, and only then', () => {
    const child = { ...AGENT, id: 'agent-2', parent: 'agent-1' };

    expect(accepts(opened(child, 's0', { spawnedAt: { channel: 'agent-1', cursor: 's7' } }))).toBe(
      true,
    );
    expect(accepts(opened(child, 's0'))).toBe(false);
    expect(accepts(opened(child, 's0', { spawnedAt: { channel: 'agent-9', cursor: 's7' } }))).toBe(
      false,
    );
    expect(accepts(opened(AGENT, 's0', { spawnedAt: { channel: 'agent-1', cursor: 's7' } }))).toBe(
      false,
    );
  });

  it('is never from a node that is its own parent', () => {
    const own = { ...AGENT, parent: 'agent-1' };

    expect(accepts(opened(own, 's0', { spawnedAt: { channel: 'agent-1', cursor: 's7' } }))).toBe(
      false,
    );
  });

  it('keeps an error text to its cap when it closes', () => {
    const closed = { channel: 'agent-1', cursor: 's9', at: 2, type: 'closed', state: 'failed' };

    expect(accepts({ ...closed, error: 'x'.repeat(MAX_NODE_ERROR_CHARS) })).toBe(true);
    expect(accepts({ ...closed, error: 'x'.repeat(MAX_NODE_ERROR_CHARS + 1) })).toBe(false);
  });
});

describe('the closed entry of a node channel', () => {
  const closed = (more: object) => ({
    channel: 'agent-1',
    cursor: 's9',
    at: 2,
    type: 'closed',
    ...more,
  });

  it.each(NODE_END_STATES)('accepts a node that ended %s', (state) => {
    expect(accepts(closed({ state }))).toBe(true);
  });

  it.each(['running', 'idle', 'stopped'])('refuses a node that is still %s', (state) => {
    expect(accepts(closed({ state }))).toBe(false);
  });

  it.each([
    ['failed', 'max_tokens', true],
    ['failed', 'context_window_exceeded', true],
    ['cancelled', 'interrupted', true],
    ['completed', 'completed', true],
    ['completed', 'failed', false],
    ['failed', 'completed', false],
    ['cancelled', 'failed', false],
    ['lost', 'completed', true],
  ])('a node that ended %s with the outcome %s is accepted: %s', (state, outcome, ok) => {
    expect(accepts(closed({ state, outcome }))).toBe(ok);
  });

  it('carries a command’s exit code, which may be none', () => {
    expect(
      accepts({ ...closed({ state: 'failed', exitCode: 2 }), channel: 't1', cursor: 'b40' }),
    ).toBe(true);
    expect(
      accepts({ ...closed({ state: 'cancelled', exitCode: null }), channel: 't1', cursor: 'b40' }),
    ).toBe(true);
  });
});

describe('how a command’s output ended, on its closed entry', () => {
  /** A command's closed entry, with `output` when there is one: an absent key, never `undefined`. */
  const closed = (output: unknown, more: object = {}) => ({
    channel: 't1',
    cursor: 'b40',
    at: 2,
    type: 'closed',
    state: 'completed',
    exitCode: 0,
    ...(output !== undefined && { output }),
    ...more,
  });

  it('is complete, or incomplete with what was lost', () => {
    expect(accepts(closed({ status: 'complete' }))).toBe(true);
    expect(
      accepts(closed({ status: 'incomplete', reason: 'the stored output reached its limit' })),
    ).toBe(true);
  });

  it.each([
    ['incomplete with no reason', { status: 'incomplete' }],
    ['complete with a reason', { status: 'complete', reason: 'nothing was lost' }],
    ['still capturing: its log was closed before the node ended', { status: 'capturing' }],
    ['a reason over its cap', { status: 'incomplete', reason: 'x'.repeat(1_001) }],
    ['an unknown status', { status: 'lost' }],
  ])('refuses %s', (_name, output) => {
    expect(accepts(closed(output))).toBe(false);
  });

  it('is only on a channel counted in bytes: an agent’s has no output', () => {
    expect(accepts(closed({ status: 'complete' }, { channel: 'agent-1', cursor: 's9' }))).toBe(
      false,
    );
  });

  it('is optional: a command that kept no output, or a node that was lost, says nothing of it', () => {
    expect(accepts(closed(undefined))).toBe(true);
    expect(accepts({ channel: 't1', cursor: 'b0', at: 2, type: 'closed', state: 'lost' })).toBe(
      true,
    );
  });
});

describe('the output entry of a command or service channel', () => {
  const output = (more: object = {}) => ({
    channel: 't1',
    cursor: 'b5',
    at: 2,
    type: 'output',
    offset: 0,
    text: 'hello',
    ...more,
  });
  const served = (value: unknown) => channelEntrySchema.safeParse(value).success;

  it('is text and the offset of its first byte, with the offset after it as its cursor', () => {
    expect(served(output())).toBe(true);
    expect(served(output({ offset: 100, cursor: 'b105' }))).toBe(true);
  });

  it('counts bytes, not characters: a character of UTF-8 is up to four', () => {
    // é is two bytes, € three, 😀 four.
    expect(served(output({ text: 'é€😀', cursor: 'b9' }))).toBe(true);
    expect(served(output({ text: 'é€😀', cursor: 'b5' }))).toBe(false);
  });

  it('is at most 16 KiB of bytes, so a chunk of wide characters is cut by its bytes', () => {
    expect(served(output({ text: 'a'.repeat(16_384), cursor: 'b16384' }))).toBe(true);
    expect(served(output({ text: 'a'.repeat(16_385), cursor: 'b16385' }))).toBe(false);
    // 5,462 euro signs are 16,386 bytes, though far fewer characters than 16,384.
    expect(served(output({ text: '€'.repeat(5_462), cursor: 'b16386' }))).toBe(false);
  });

  it.each([
    ['a cursor that is not the offset after it', output({ cursor: 'b4' })],
    ['a cursor before its own offset', output({ offset: 10, cursor: 'b5' })],
    ['a sequence cursor', output({ cursor: 's5' })],
    ['no text', output({ text: '', cursor: 'b0' })],
    ['an offset that is not whole', output({ offset: 0.5, cursor: 'b5' })],
    ['a negative offset', output({ offset: -1, cursor: 'b4' })],
    ['text that is not text: a lone surrogate', output({ text: 'a\ud800', cursor: 'b4' })],
  ])('refuses %s', (_name, value) => {
    expect(served(value)).toBe(false);
  });

  it('is not an entry of a channel’s stored log between its boundaries: it is served, not kept', () => {
    // A stored channel is the two boundary entries; an output entry is made from the output store.
    expect(accepts(output())).toBe(false);
  });
});

describe('the entries of the tree channel', () => {
  const tree = (type: string, cursor: string) => ({ channel: 'tree', cursor, at: 1, type });

  it('opens at 0 and closes on a number', () => {
    expect(accepts(tree('opened', 's0'))).toBe(true);
    expect(accepts(tree('closed', 's12'))).toBe(true);
  });

  it.each([
    ['opens at a byte offset', tree('opened', 'b0')],
    ['opens at 1', tree('opened', 's1')],
    ['closes at a byte offset', tree('closed', 'b9')],
  ])('refuses a tree channel that %s', (_name, entry) => {
    expect(accepts(entry)).toBe(false);
  });
});

describe('a node state that a channel ends in', () => {
  it('is a state the status table leaves no move from', () => {
    const final = NODE_STATES.filter((state) => STATUS_TABLE.node[state].length === 0);

    expect([...NODE_END_STATES]).toEqual(final);
  });
});

describe('the log of one channel', () => {
  const entry = (type: string, cursor: string, channel = 'agent-1') => ({
    channel,
    cursor,
    at: 1,
    type,
  });
  const accepted = (entries: object[]) => channelLogSchema.safeParse(entries).success;

  it.each([
    ['no entry yet', []],
    ['one still open', [entry('opened', 's0'), entry('event', 's1')]],
    [
      'one that opened and closed',
      [entry('opened', 's0'), entry('event', 's1'), entry('closed', 's2')],
    ],
    ['one that opened and closed at once', [entry('opened', 's0'), entry('closed', 's1')]],
    [
      'output that never goes back and may stay',
      [
        entry('opened', 'b0'),
        entry('output', 'b0'),
        entry('output', 'b10'),
        entry('output', 'b10'),
        entry('closed', 'b30'),
      ],
    ],
    ['the tree channel, numbered', [entry('opened', 's0', 'tree'), entry('node', 's1', 'tree')]],
  ])('accepts %s', (_name, entries) => {
    expect(accepted(entries)).toBe(true);
  });

  it.each([
    ['closed without opened', [entry('closed', 's0')]],
    ['an entry before opened', [entry('event', 's0'), entry('opened', 's1')]],
    ['an entry after closed', [entry('opened', 's0'), entry('closed', 's1'), entry('event', 's2')]],
    ['closed twice', [entry('opened', 's0'), entry('closed', 's1'), entry('closed', 's2')]],
    ['opened twice', [entry('opened', 's0'), entry('opened', 's1')]],
    [
      'closed before the end',
      [entry('opened', 's0'), entry('closed', 's1'), entry('event', 's2'), entry('closed', 's3')],
    ],
    ['a gap in a sequence', [entry('opened', 's0'), entry('event', 's2')]],
    [
      'a sequence that repeats',
      [entry('opened', 's0'), entry('event', 's1'), entry('event', 's1')],
    ],
    ['a sequence that does not start at 0', [entry('opened', 's1'), entry('event', 's2')]],
    ['bytes that go back', [entry('opened', 'b0'), entry('output', 'b10'), entry('output', 'b5')]],
    ['bytes that do not start at 0', [entry('opened', 'b4'), entry('output', 'b10')]],
    ['a byte offset in a sequence', [entry('opened', 's0'), entry('event', 'b1')]],
    ['a sequence in a byte channel', [entry('opened', 'b0'), entry('output', 's1')]],
    [
      'a tree channel with byte offsets',
      [entry('opened', 'b0', 'tree'), entry('node', 'b1', 'tree')],
    ],
    ['entries of two channels', [entry('opened', 's0'), entry('event', 's1', 'agent-2')]],
    [
      'an entry whose type is not a name',
      [entry('opened', 's0'), entry('x'.repeat(MAX_ENTRY_TYPE_CHARS + 1), 's1')],
    ],
  ])('refuses %s', (_name, entries) => {
    expect(accepted(entries)).toBe(false);
  });
});

describe('the updated entry of an agent channel', () => {
  const updated = (more: object = {}) => ({
    channel: 'agent-1',
    cursor: 's3',
    at: 2,
    type: 'updated',
    node: AGENT,
    ...more,
  });
  const served = (value: unknown) => channelEntrySchema.safeParse(value).success;

  it('is the agent as it is now, numbered after its opened entry', () => {
    expect(served(updated())).toBe(true);
    expect(served(updated({ cursor: 's1' }))).toBe(true);
  });

  it.each([
    ['one numbered like the opened entry', updated({ cursor: 's0' })],
    ['one counted in bytes', updated({ cursor: 'b3' })],
    ['a command’s', updated({ channel: 't1', cursor: 's3', node: COMMAND })],
    ['one of another node than its channel’s', updated({ channel: 'agent-2' })],
    ['one with no node', updated({ node: undefined })],
    ['one on the tree channel', updated({ channel: 'tree' })],
  ])('refuses %s', (_name, value) => {
    expect(served(value)).toBe(false);
  });

  it('is served with the two boundary entries, and no other entry a channel might hold', () => {
    expect(served(opened(AGENT, 's0'))).toBe(true);
    expect(
      served({ channel: 'agent-1', cursor: 's9', at: 2, type: 'closed', state: 'failed' }),
    ).toBe(true);
    expect(served({ channel: 'agent-1', cursor: 's4', at: 2, type: 'event' })).toBe(false);
  });
});

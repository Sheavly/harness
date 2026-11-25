import { describe, expect, it } from 'vitest';
import { MAX_READ_BYTES } from '../../output/output.constants.js';
import { serverErrorCodeSchema } from '../../server/server.validator.js';
import {
  CHANNEL_END_REASONS,
  END_EVENT,
  HEAD_EVENT,
  MAX_SUBSCRIPTIONS,
  MAX_TAIL,
  MAX_TAIL_BYTES,
  SNAPSHOT_EVENT,
} from '../subscription.constants.js';
import {
  channelEndFrameSchema,
  channelHeadFrameSchema,
  subscribeFrameSchema,
  subscribeFromSchema,
  subscribeRequestSchema,
} from '../subscription.validator.js';

/** A request that follows `subscriptions`, each `[channel, from]`. */
const request = (subscriptions: [string, string][], more: object = {}) => ({
  subscriptions: subscriptions.map(([channel, from]) => ({ channel, from })),
  ...more,
});
const accepts = (value: unknown) => subscribeRequestSchema.safeParse(value).success;

describe('where to start', () => {
  it.each([
    'start',
    'now',
    'snapshot',
    'tail:1',
    'tail:50',
    `tail:${String(MAX_TAIL_BYTES)}`,
    's0',
    's41',
    'b4096',
  ])('accepts %s', (from) => {
    expect(subscribeFromSchema.safeParse(from).success).toBe(true);
  });

  it.each([
    ['a keyword it does not have', 'later'],
    ['a tail of nothing', 'tail:0'],
    ['a negative tail', 'tail:-1'],
    ['a tail that is not a whole number', 'tail:1.5'],
    ['a tail with no number', 'tail:'],
    ['a tail with a leading zero', 'tail:05'],
    ['a tail over the bound', `tail:${String(MAX_TAIL_BYTES + 1)}`],
    ['a bare number', '12'],
    ['a cursor that is not one', 's-1'],
    ['an empty position', ''],
  ])('refuses %s', (_name, from) => {
    expect(subscribeFromSchema.safeParse(from).success).toBe(false);
  });
});

describe('a subscribe request', () => {
  it.each([
    ['the tree from its snapshot', request([['tree', 'snapshot']])],
    [
      'the tree and a node it shows',
      request([
        ['tree', 'snapshot'],
        ['agent-2', 's7'],
      ]),
    ],
    ['the output of a command from an offset', request([['t1', 'b4096']])],
    ['the last lines of a command’s output', request([['t1', 'tail:2000']])],
    ['an agent from its start', request([['agent-1', 'start']])],
    ['what comes, with nothing before it', request([['agent-1', 'now']])],
    ['the tree and approvals it can answer', request([['tree', 's9']], { approvals: true })],
    ['a node with approvals not asked for', request([['agent-1', 's9']], { approvals: false })],
    [
      'as many channels as it may',
      request(
        Array.from({ length: MAX_SUBSCRIPTIONS }, (_unused, index) => [`n${String(index)}`, 'now']),
      ),
    ],
  ])('follows %s', (_name, value) => {
    expect(accepts(value)).toBe(true);
  });

  it.each([
    ['no channel', request([])],
    [
      'more channels than it may',
      request(
        Array.from({ length: MAX_SUBSCRIPTIONS + 1 }, (_unused, index) => [
          `n${String(index)}`,
          'now',
        ]),
      ),
    ],
    [
      'a channel twice',
      request([
        ['agent-1', 's1'],
        ['agent-1', 's5'],
      ]),
    ],
    ['a snapshot of a node', request([['agent-1', 'snapshot']])],
    ['the tree from a byte offset', request([['tree', 'b4']])],
    [
      'a tail of the tree over the bound for a numbered channel',
      request([['tree', `tail:${String(MAX_TAIL + 1)}`]]),
    ],
    ['approvals with no tree channel', request([['agent-1', 's9']], { approvals: true })],
    ['a channel that is not a name', request([['a/b', 'start']])],
    ['a position that is missing', { subscriptions: [{ channel: 'tree' }] }],
    ['no subscriptions at all', {}],
  ])('does not follow %s', (_name, value) => {
    expect(accepts(value)).toBe(false);
  });

  it('takes the last MAX_TAIL entries of the tree, and no more', () => {
    expect(accepts(request([['tree', `tail:${String(MAX_TAIL)}`]]))).toBe(true);
  });
});

describe('a frame of a subscribe stream', () => {
  const frame = (value: unknown) => subscribeFrameSchema.safeParse(value).success;
  const opened = {
    channel: 'agent-1',
    cursor: 's0',
    at: 1,
    type: 'opened',
    node: { kind: 'agent', id: 'agent-1', title: 'Main', state: 'running', startedAt: 1 },
  };

  const main = { kind: 'agent', id: 'agent-1', title: 'Main', state: 'running', startedAt: 1 };
  const snapshot = {
    channel: 'tree',
    cursor: 's4',
    at: 9,
    type: SNAPSHOT_EVENT,
    nodes: [main],
    approvals: [],
  };

  it.each([
    ['an entry of a channel', opened],
    [
      'an entry of the tree channel',
      { channel: 'tree', cursor: 's1', at: 2, type: 'node_opened', node: main },
    ],
    ['the tree as it stands', snapshot],
    ['where a channel stood at now', { type: HEAD_EVENT, channel: 'agent-1', cursor: 's7' }],
    [
      'the end of a channel that closed',
      { type: END_EVENT, channel: 'agent-1', reason: 'completed', cursor: 's9' },
    ],
    [
      'the end of a channel the consumer fell behind',
      { type: END_EVENT, channel: 'agent-1', reason: 'cut_off', cursor: 's4' },
    ],
    [
      'the end of a channel with nothing delivered',
      { type: END_EVENT, channel: 't1', reason: 'cut_off' },
    ],
    [
      'the end of a channel whose storage failed',
      { type: END_EVENT, channel: 'agent-1', reason: 'failed', cursor: 's4' },
    ],
  ])('is %s', (_name, value) => {
    expect(frame(value)).toBe(true);
  });

  it.each([
    ['a head frame with no cursor', { type: HEAD_EVENT, channel: 'agent-1' }],
    [
      'a head frame of a cursor that is not one',
      { type: HEAD_EVENT, channel: 'agent-1', cursor: '7' },
    ],
    [
      'an end frame with a reason it does not have',
      { type: END_EVENT, channel: 'agent-1', reason: 'timeout' },
    ],
    ['an end frame with no reason', { type: END_EVENT, channel: 'agent-1' }],
    [
      'an end frame of a channel that is not a name',
      { type: END_EVENT, channel: 'a/b', reason: 'completed' },
    ],
    [
      'an end frame with a cursor that is not one',
      { type: END_EVENT, channel: 'agent-1', reason: 'completed', cursor: 'x' },
    ],
    ['an entry no channel holds', { channel: 'agent-1', cursor: 's4', at: 1, type: 'event' }],
    ['a snapshot of a channel that is not the tree', { ...snapshot, channel: 'agent-1' }],
    ['a snapshot at a byte offset', { ...snapshot, cursor: 'b4' }],
    ['a snapshot that does not hold together: a node twice', { ...snapshot, nodes: [main, main] }],
    [
      'a snapshot whose approval is asked by a node it does not have',
      {
        ...snapshot,
        approvals: [
          {
            node: 'agent-9',
            request: {
              id: 'a1',
              callId: 'call_1',
              tool: 'run_command',
              command: 'ls',
              concerns: [],
              options: ['approve', 'skip'],
            },
          },
        ],
      },
    ],
    ['a snapshot with no cursor', { ...snapshot, cursor: undefined }],
    ['nothing', {}],
  ])('is not %s', (_name, value) => {
    expect(frame(value)).toBe(false);
  });

  it('keeps the snapshot apart from the control frames and from every entry', () => {
    expect(channelHeadFrameSchema.safeParse(snapshot).success).toBe(false);
    expect(channelEndFrameSchema.safeParse(snapshot).success).toBe(false);
    expect(subscribeFrameSchema.safeParse({ ...snapshot, type: 'node_opened' }).success).toBe(
      false,
    );
  });

  it('keeps an entry apart from the two control frames: neither parses as the other', () => {
    expect(channelHeadFrameSchema.safeParse(opened).success).toBe(false);
    expect(channelEndFrameSchema.safeParse(opened).success).toBe(false);
    expect(
      channelEndFrameSchema.safeParse({ type: HEAD_EVENT, channel: 'agent-1', cursor: 's7' })
        .success,
    ).toBe(false);
  });

  it('names its event the way its data names its type, for the three frames that are not entries', () => {
    expect([HEAD_EVENT, END_EVENT, SNAPSHOT_EVENT]).toEqual(['head', 'end', 'snapshot']);
    expect(CHANNEL_END_REASONS).toEqual(['completed', 'cut_off', 'failed']);
  });
});

describe('the limits', () => {
  it('keep the byte bound equal to the output store’s read bound, so a tail is one read', () => {
    expect(MAX_TAIL_BYTES).toBe(MAX_READ_BYTES);
  });

  it('give a position the log cannot start at an error of its own, not bad_request', () => {
    expect(serverErrorCodeSchema.options).toContain('cursor_out_of_range');
    expect(serverErrorCodeSchema.options).toContain('bad_request');
  });

  it('give a conversation that serves as many subscriptions as it may a code a client retries on', () => {
    expect(serverErrorCodeSchema.options).toContain('too_many_subscriptions');
  });
});

import { describe, expect, it } from 'vitest';
import { MAX_READ_BYTES } from '../../output/output.constants.js';
import { serverErrorCodeSchema } from '../../server/server.validator.js';
import { MAX_SUBSCRIPTIONS, MAX_TAIL, MAX_TAIL_BYTES } from '../subscription.constants.js';
import { subscribeFromSchema, subscribeRequestSchema } from '../subscription.validator.js';

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

describe('the limits', () => {
  it('keep the byte bound equal to the output store’s read bound, so a tail is one read', () => {
    expect(MAX_TAIL_BYTES).toBe(MAX_READ_BYTES);
  });

  it('give a position the log cannot start at an error of its own, not bad_request', () => {
    expect(serverErrorCodeSchema.options).toContain('cursor_out_of_range');
    expect(serverErrorCodeSchema.options).toContain('bad_request');
  });
});

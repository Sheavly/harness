import { describe, expect, it } from 'vitest';
import type { EntryEvent } from '@sheavly/protocol/event/event.types';
import { entryEventSchema } from '@sheavly/protocol/event/event.validator';
import { MAX_TREE_NODES } from '@sheavly/protocol/node/node.constants';
import { nodeIdSchema } from '@sheavly/protocol/node/node.validator';
import { nodeUsageEntrySchema } from '@sheavly/protocol/usage/usage-channel.validator';
import type { ModelUsage } from '@sheavly/protocol/usage/usage.types';
import { emptyUsage, emptyUsageFigures } from '@sheavly/protocol/usage/usage.utils';
import { NodeUsageLedger } from '../node-usage.service.js';

const MAIN = nodeIdSchema.parse('main');
const HELPER = nodeIdSchema.parse('helper');

const TOKENS = {
  inputTokens: 1_000,
  outputTokens: 200,
  cacheReadTokens: 600,
  cacheWriteTokens: 100,
};
/**
 * A usage event the loop could send: parsed, so a test never feeds the ledger what it could not. A
 * field given as `undefined` is left out, as the loop leaves out what it does not know.
 */
const called = (usage: Record<string, unknown> = {}) =>
  entryEventSchema.parse({
    seq: 0,
    type: 'usage',
    usage: Object.fromEntries(
      Object.entries({
        tokens: TOKENS,
        estimatedCostUsd: 0.01,
        contextWindow: 200_000,
        ...usage,
      }).filter(([, value]) => value !== undefined),
    ),
  });
/**
 * A usage event with `usage` as a provider reported it, which nothing has checked: the event
 * schema is the contract and refuses what these tests need the ledger to meet anyway.
 */
const unchecked = (usage: ModelUsage): EntryEvent => ({ seq: 0, type: 'usage', usage });
const turnEnd = entryEventSchema.parse({
  seq: 1,
  type: 'turn_end',
  turn: 0,
  stopReason: 'end_turn',
});
const textDelta = entryEventSchema.parse({ seq: 2, type: 'text_delta', text: 'hello' });

const ledger = (open: (node: string) => boolean = () => true) =>
  new NodeUsageLedger({ isOpen: open });

describe('the per-node usage ledger', () => {
  it('counts a call into its node: calls, tokens with the cache tokens apart, and the cost the call carries', () => {
    const counted = ledger();
    const change = counted.observe({ node: MAIN, event: called() });

    expect(change?.usage).toMatchObject({
      node: MAIN,
      calls: 1,
      inputTokens: 1_000,
      outputTokens: 200,
      cacheReadTokens: 600,
      cacheWriteTokens: 100,
      estimatedCostUsd: 0.01,
      missingUsageCalls: 0,
      unpricedCalls: 0,
      incomplete: false,
    });
    expect(change?.total).toMatchObject({ calls: 1, cacheReadTokens: 600, estimatedCostUsd: 0.01 });
  });

  it('counts a call with no price as unpriced, adding no cost, and one with no tokens as missing, never as zero usage', () => {
    const counted = ledger();

    counted.observe({ node: MAIN, event: called({ estimatedCostUsd: undefined }) });

    const change = counted.observe({
      node: MAIN,
      event: called({ tokens: null, estimatedCostUsd: undefined }),
    });

    expect(change?.usage).toMatchObject({
      calls: 2,
      inputTokens: 1_000,
      estimatedCostUsd: 0,
      unpricedCalls: 2,
      missingUsageCalls: 1,
    });
  });

  it('keeps each node’s own figures and a total of them all', () => {
    const counted = ledger();

    counted.observe({ node: MAIN, event: called() });
    counted.observe({ node: HELPER, event: called({ estimatedCostUsd: 0.02 }) });

    const change = counted.observe({ node: MAIN, event: called() });

    expect(counted.view.nodes.map(({ node, calls }) => [node, calls])).toEqual([
      [MAIN, 2],
      [HELPER, 1],
    ]);
    expect(change?.total).toMatchObject({ calls: 3, inputTokens: 3_000, estimatedCostUsd: 0.04 });
  });

  it('says how full an agent’s context was at its last call: used, cached and the window', () => {
    const counted = ledger();

    counted.observe({ node: MAIN, event: called() });

    expect(counted.view.nodes[0]?.context).toEqual({ used: 1_200, cached: 600, window: 200_000 });

    const next = counted.observe({
      node: MAIN,
      event: called({
        tokens: { ...TOKENS, inputTokens: 2_000, outputTokens: 50, cacheReadTokens: 0 },
      }),
    });

    expect(next?.usage.context).toMatchObject({ used: 2_050, cached: 0 });
  });

  it('counts a summary call in the figures and leaves the context as it was', () => {
    const counted = ledger();

    counted.observe({ node: MAIN, event: called() });

    const summary = counted.observe({
      node: MAIN,
      event: called({ purpose: 'summary', tokens: { ...TOKENS, inputTokens: 9_000 } }),
    });

    expect(summary?.usage.calls).toBe(2);
    expect(summary?.usage.inputTokens).toBe(10_000);
    expect(summary?.usage.context).toEqual({ used: 1_200, cached: 600, window: 200_000 });
  });

  it('leaves out of the context what a call did not report', () => {
    const counted = ledger();
    const change = counted.observe({
      node: MAIN,
      event: called({ tokens: null, contextWindow: undefined }),
    });

    expect(change?.usage.context).toEqual({});
  });

  it('marks a node and the total incomplete when a turn ends having reported no usage, once', () => {
    const counted = ledger();
    const first = counted.observe({ node: MAIN, event: turnEnd });

    expect(first?.usage).toMatchObject({ node: MAIN, calls: 0, incomplete: true });
    expect(first?.total.incomplete).toBe(true);
    expect(counted.observe({ node: MAIN, event: turnEnd })).toBeUndefined();
  });

  it('does not mark a turn incomplete that reported its usage, and a summary call is not that report', () => {
    const counted = ledger();

    counted.observe({ node: MAIN, event: called() });

    expect(counted.observe({ node: MAIN, event: turnEnd })).toBeUndefined();

    counted.observe({ node: HELPER, event: called({ purpose: 'summary' }) });

    expect(counted.observe({ node: HELPER, event: turnEnd })?.usage).toMatchObject({
      incomplete: true,
    });
    expect(counted.view.nodes.find(({ node }) => node === MAIN)?.incomplete).toBe(false);
  });

  it('counts a turn’s report for the turn it belongs to: the next turn must report its own', () => {
    const counted = ledger();

    counted.observe({ node: MAIN, event: called() });
    counted.observe({ node: MAIN, event: turnEnd });

    expect(counted.observe({ node: MAIN, event: turnEnd })?.usage.incomplete).toBe(true);
  });

  it('counts nothing for an event that is not usage or a turn’s end', () => {
    expect(ledger().observe({ node: MAIN, event: textDelta })).toBeUndefined();
  });

  it('goes on from the usage a reopened channel left: the figures carry on and the total covers the earlier nodes', () => {
    const first = ledger();

    first.observe({ node: MAIN, event: called() });

    const second = new NodeUsageLedger({ isOpen: () => true, initial: first.view });
    const change = second.observe({ node: HELPER, event: called() });

    expect(change?.total.calls).toBe(2);
    expect(second.view.nodes.map(({ node }) => node)).toEqual([MAIN, HELPER]);
  });

  it.each([
    ['negative tokens', { ...TOKENS, inputTokens: -1 }],
    ['tokens that are not whole', { ...TOKENS, outputTokens: 1.5 }],
    ['more cached than were sent', { ...TOKENS, inputTokens: 10 }],
    ['tokens that are not a number', { ...TOKENS, cacheReadTokens: Number.NaN }],
  ])('counts %s as tokens the provider did not report, never as usage', (_name, tokens) => {
    const change = ledger().observe({
      node: MAIN,
      event: unchecked({ tokens, estimatedCostUsd: 0.01 }),
    });

    expect(change?.usage).toMatchObject({
      calls: 1,
      inputTokens: 0,
      cacheReadTokens: 0,
      missingUsageCalls: 1,
      estimatedCostUsd: 0.01,
    });
    // Nor does it say anything of how full the context is.
    expect(change?.usage.context).toEqual({});
  });

  it.each([
    ['a negative cost', -1],
    ['a cost that is not a number', Number.NaN],
    ['an infinite cost', Number.POSITIVE_INFINITY],
  ])('counts %s as no price, adding nothing', (_name, estimatedCostUsd) => {
    const change = ledger().observe({
      node: MAIN,
      event: unchecked({ tokens: TOKENS, estimatedCostUsd }),
    });

    expect(change?.usage).toMatchObject({
      estimatedCostUsd: 0,
      unpricedCalls: 1,
      inputTokens: 1_000,
    });
  });

  it('holds a sum at the largest figure the channel takes, so absurd numbers cannot end the channel', () => {
    const counted = ledger();
    const huge = { ...TOKENS, inputTokens: Number.MAX_SAFE_INTEGER, outputTokens: 5 };

    counted.observe({ node: MAIN, event: unchecked({ tokens: huge, estimatedCostUsd: 1e300 }) });

    const change = counted.observe({
      node: MAIN,
      event: unchecked({ tokens: huge, estimatedCostUsd: 1e300 }),
    });

    expect(change?.total.inputTokens).toBe(Number.MAX_SAFE_INTEGER);
    expect(change?.usage.estimatedCostUsd).toBe(Number.MAX_SAFE_INTEGER);
    expect(change?.usage.context?.used).toBe(Number.MAX_SAFE_INTEGER);
    // What it tells is what the channel's schema takes, however it got there.
    expect(
      nodeUsageEntrySchema.safeParse({
        channel: 'usage',
        cursor: 's1',
        at: 1,
        type: 'node_usage',
        usage: change?.usage,
        total: change?.total,
      }).success,
    ).toBe(true);
  });

  it('starts empty', () => {
    expect(ledger().view).toEqual(emptyUsage());
    expect(ledger().view.total).toEqual(emptyUsageFigures());
  });
});

describe('the records the ledger keeps', () => {
  const ids = Array.from({ length: MAX_TREE_NODES + 2 }, (_, index) =>
    nodeIdSchema.parse(`n${String(index)}`),
  );

  /** A ledger in which every node of `ids` but the first `count` has made a call. */
  function full(params: { open: (node: string) => boolean; count?: number }) {
    const counted = ledger(params.open);

    for (const node of ids.slice(0, params.count ?? MAX_TREE_NODES)) {
      counted.observe({ node, event: called() });
    }

    return counted;
  }

  it('are at most as many as a snapshot holds: past that the oldest records of nodes that are not open are dropped, and said', () => {
    const counted = full({ open: () => false });
    const change = counted.observe({ node: ids[MAX_TREE_NODES] ?? MAIN, event: called() });

    expect(change?.evicted).toEqual([ids[0]]);
    expect(counted.view.nodes).toHaveLength(MAX_TREE_NODES);
    expect(counted.view.nodes.map(({ node }) => node)).not.toContain(ids[0]);
  });

  it('leave the total covering every call, the dropped nodes’ included', () => {
    const counted = full({ open: () => false });
    const change = counted.observe({ node: ids[MAX_TREE_NODES] ?? MAIN, event: called() });

    expect(change?.total.calls).toBe(MAX_TREE_NODES + 1);
  });

  it('keep a node that is open, however old: the first record that is not goes instead', () => {
    const counted = full({ open: (node) => node === ids[0] });
    const change = counted.observe({ node: ids[MAX_TREE_NODES] ?? MAIN, event: called() });

    expect(change?.evicted).toEqual([ids[1]]);
    expect(counted.view.nodes.map(({ node }) => node)).toContain(ids[0]);
  });

  it('never drop the node the change is about, and drop none when every node is open', () => {
    const counted = full({ open: () => true });
    const change = counted.observe({ node: ids[MAX_TREE_NODES] ?? MAIN, event: called() });

    expect(change?.evicted).toEqual([]);
    expect(counted.view.nodes).toHaveLength(MAX_TREE_NODES + 1);
  });

  it('drop as many as it takes when a ledger went on from more than may be kept', () => {
    const counted = full({ open: () => false, count: MAX_TREE_NODES });
    const change = counted.observe({ node: ids[MAX_TREE_NODES] ?? MAIN, event: called() });
    const second = counted.observe({ node: ids[MAX_TREE_NODES + 1] ?? MAIN, event: called() });

    expect(change?.evicted).toHaveLength(1);
    expect(second?.evicted).toHaveLength(1);
    expect(counted.view.nodes).toHaveLength(MAX_TREE_NODES);
  });
});

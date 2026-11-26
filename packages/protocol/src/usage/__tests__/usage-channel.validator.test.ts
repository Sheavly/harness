import { describe, expect, it } from 'vitest';
import { MAX_TREE_NODES } from '../../node/node.constants.js';
import { channelEntrySchema } from '../../channel/channel.validator.js';
import { subscribeFrameSchema } from '../../subscription/subscription.validator.js';
import {
  nodeUsageSchema,
  usageChannelEntrySchema,
  usageSnapshotSchema,
} from '../usage-channel.validator.js';

const FIGURES = {
  calls: 2,
  inputTokens: 300,
  outputTokens: 40,
  cacheReadTokens: 100,
  cacheWriteTokens: 0,
  estimatedCostUsd: 0.01,
  missingUsageCalls: 0,
  unpricedCalls: 0,
  incomplete: false,
};
const node = (id: string) => ({ ...FIGURES, node: id });
const entry = (overrides: object = {}) => ({
  channel: 'usage',
  cursor: 's1',
  at: 10,
  type: 'node_usage',
  usage: node('main'),
  total: FIGURES,
  ...overrides,
});
const snapshot = (overrides: object = {}) => ({
  channel: 'usage',
  cursor: 's1',
  at: 10,
  type: 'snapshot',
  total: FIGURES,
  nodes: [node('main')],
  ...overrides,
});

describe('a node’s usage', () => {
  it('is its figures and, for an agent, how full its context was', () => {
    expect(nodeUsageSchema.safeParse(node('main')).success).toBe(true);
    expect(
      nodeUsageSchema.safeParse({
        ...node('main'),
        context: { used: 90, cached: 40, window: 200_000 },
      }).success,
    ).toBe(true);
  });

  it.each([
    ['a negative count', { calls: -1 }],
    ['a fraction of a call', { calls: 1.5 }],
    ['a negative cost', { estimatedCostUsd: -0.01 }],
    ['an id that is a conversation channel’s name', { node: 'usage' }],
    ['a context with a negative figure', { context: { used: -1 } }],
  ])('refuses %s', (_name, overrides) => {
    expect(nodeUsageSchema.safeParse({ ...node('main'), ...overrides }).success).toBe(false);
  });
});

describe('the usage channel’s entries', () => {
  it('are its opening and closing, numbered, and a node’s changed usage', () => {
    for (const parsed of [
      { channel: 'usage', cursor: 's0', at: 1, type: 'opened' },
      { channel: 'usage', cursor: 's9', at: 1, type: 'closed' },
      entry(),
    ]) {
      expect(usageChannelEntrySchema.safeParse(parsed).success, JSON.stringify(parsed)).toBe(true);
    }
  });

  it.each([
    ['another channel’s name', entry({ channel: 'tree' })],
    ['a node’s id as its channel', entry({ channel: 'main' })],
    ['a byte cursor, the channel being numbered', entry({ cursor: 'b4' })],
    ['an opening that is not at 0', { channel: 'usage', cursor: 's3', at: 1, type: 'opened' }],
    ['no total', entry({ total: undefined })],
    ['an entry type it does not have', entry({ type: 'node_closed' })],
  ])('refuse %s', (_name, parsed) => {
    expect(usageChannelEntrySchema.safeParse(parsed).success).toBe(false);
  });

  it('may say, on its opening only, that earlier calls went uncounted, and only as true', () => {
    const opening = { channel: 'usage', cursor: 's0', at: 1, type: 'opened' };

    expect(usageChannelEntrySchema.safeParse({ ...opening, earlierUncounted: true }).success).toBe(
      true,
    );
    expect(usageChannelEntrySchema.safeParse({ ...opening, earlierUncounted: false }).success).toBe(
      false,
    );
    // The generic boundary a subscription also parses frames with must not drop it.
    expect(subscribeFrameSchema.parse({ ...opening, earlierUncounted: true })).toMatchObject({
      earlierUncounted: true,
    });
  });

  it('may say which nodes’ records are no longer kept, ids and no more than a snapshot holds', () => {
    const tooMany = Array.from({ length: MAX_TREE_NODES + 1 }, (_, index) => `n${String(index)}`);

    expect(usageChannelEntrySchema.safeParse(entry({ evicted: ['old'] })).success).toBe(true);
    expect(usageChannelEntrySchema.safeParse(entry({ evicted: [] })).success).toBe(true);
    expect(usageChannelEntrySchema.safeParse(entry({ evicted: ['tree'] })).success).toBe(false);
    expect(usageChannelEntrySchema.safeParse(entry({ evicted: tooMany })).success).toBe(false);
  });

  it('are served: a subscription’s frame is one, and a node’s channel schema does not take it', () => {
    expect(subscribeFrameSchema.safeParse(entry()).success).toBe(true);
    expect(channelEntrySchema.safeParse(entry()).success).toBe(false);
  });
});

describe('the usage snapshot', () => {
  it('is the total and each node once, at a cursor, and is a frame a subscription serves', () => {
    expect(usageSnapshotSchema.safeParse(snapshot()).success).toBe(true);
    expect(subscribeFrameSchema.safeParse(snapshot()).success).toBe(true);
    expect(usageSnapshotSchema.safeParse(snapshot({ nodes: [] })).success).toBe(true);
  });

  it('refuses a node twice, a byte cursor, more nodes than the tree holds, and the tree’s name', () => {
    expect(usageSnapshotSchema.safeParse(snapshot({ nodes: [node('a'), node('a')] })).success).toBe(
      false,
    );
    expect(usageSnapshotSchema.safeParse(snapshot({ cursor: 'b1' })).success).toBe(false);
    expect(usageSnapshotSchema.safeParse(snapshot({ channel: 'tree' })).success).toBe(false);

    const many = Array.from({ length: MAX_TREE_NODES + 1 }, (_, index) =>
      node(`n${String(index)}`),
    );

    expect(usageSnapshotSchema.safeParse(snapshot({ nodes: many })).success).toBe(false);
    expect(usageSnapshotSchema.safeParse(snapshot({ nodes: many.slice(1) })).success).toBe(true);
  });
});

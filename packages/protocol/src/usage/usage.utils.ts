import { USAGE_CHANNEL_NAME } from '../node/node.constants.js';
import type { UsageChannelEntry, UsageFigures, UsageSnapshot, UsageView } from './usage.types.js';

/** The figures of no call at all. */
export function emptyUsageFigures(): UsageFigures {
  return {
    calls: 0,
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    estimatedCostUsd: 0,
    missingUsageCalls: 0,
    unpricedCalls: 0,
    incomplete: false,
  };
}

/** The usage of a conversation that has made no call. */
export function emptyUsage(): UsageView {
  return { total: emptyUsageFigures(), nodes: [] };
}

/**
 * Folds one entry of the usage channel into `usage`: a node's record is replaced (or added, the
 * first time it is seen, after the nodes already there), the records of the nodes the entry says
 * are no longer kept (`evicted`) are dropped, and the total is the one the entry carries. An
 * opening that says earlier calls went uncounted (`earlierUncounted`) makes the total
 * `incomplete`, a lower bound. Every other entry (the channel's own closing, and an opening that
 * says nothing) changes nothing, so a client may fold the whole channel through this and ignore
 * the entries it only shows.
 *
 * It is the one rule from entries to usage: a snapshot followed by the entries after its cursor
 * gives the same usage as every entry from the start. Entries carry what the usage now is, never
 * what was added, so folding one twice gives the same usage as folding it once.
 */
export function applyUsageEntry(params: { usage: UsageView; entry: UsageChannelEntry }): UsageView {
  const { usage, entry } = params;

  if (entry.type === 'opened' && entry.earlierUncounted) {
    return { ...usage, total: { ...usage.total, incomplete: true } };
  }

  if (entry.type !== 'node_usage') return usage;

  const evicted = new Set(entry.evicted ?? []);
  const kept = usage.nodes.filter(({ node }) => !evicted.has(node) || node === entry.usage.node);
  const known = kept.some(({ node }) => node === entry.usage.node);

  return {
    total: entry.total,
    nodes: known
      ? kept.map((record) => (record.node === entry.usage.node ? entry.usage : record))
      : [...kept, entry.usage],
  };
}

/** The snapshot of `usage` as it stands after the entry at `cursor`, written at `at`. */
export function usageSnapshotOf(params: {
  usage: UsageView;
  cursor: string;
  at: number;
}): UsageSnapshot {
  const { usage, cursor, at } = params;

  return {
    channel: USAGE_CHANNEL_NAME,
    cursor,
    at,
    type: 'snapshot',
    total: usage.total,
    nodes: usage.nodes,
  };
}

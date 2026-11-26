import { describe, expect, it } from 'vitest';
import { usageChannelEntrySchema, usageSnapshotSchema } from '../usage-channel.validator.js';
import type { UsageChannelEntry, UsageFigures } from '../usage.types.js';
import { applyUsageEntry, emptyUsage, emptyUsageFigures, usageSnapshotOf } from '../usage.utils.js';

const figures = (calls: number): UsageFigures => ({
  ...emptyUsageFigures(),
  calls,
  inputTokens: calls * 100,
});

/** An entry the schema accepts: parsed, so the test builds what a server sends. */
const used = (params: { cursor: number; node: string; calls: number; total: number }) =>
  usageChannelEntrySchema.parse({
    channel: 'usage',
    cursor: `s${String(params.cursor)}`,
    at: params.cursor,
    type: 'node_usage',
    usage: { ...figures(params.calls), node: params.node },
    total: figures(params.total),
  });
const opened = usageChannelEntrySchema.parse({
  channel: 'usage',
  cursor: 's0',
  at: 0,
  type: 'opened',
});
const LOG: UsageChannelEntry[] = [
  opened,
  used({ cursor: 1, node: 'main', calls: 1, total: 1 }),
  used({ cursor: 2, node: 'helper', calls: 1, total: 2 }),
  used({ cursor: 3, node: 'main', calls: 2, total: 3 }),
  used({ cursor: 4, node: 'helper', calls: 3, total: 5 }),
];

const fold = (entries: readonly UsageChannelEntry[], from = emptyUsage()) =>
  entries.reduce((usage, entry) => applyUsageEntry({ usage, entry }), from);

describe('applyUsageEntry', () => {
  it('adds a node the first time it is seen, after the ones there, and takes the total the entry carries', () => {
    const usage = fold(LOG.slice(0, 3));

    expect(usage.nodes.map(({ node }) => node)).toEqual(['main', 'helper']);
    expect(usage.total).toEqual(figures(2));
  });

  it('replaces a node’s record in place, so a node keeps its place', () => {
    const usage = fold(LOG);

    expect(usage.nodes.map(({ node, calls }) => [node, calls])).toEqual([
      ['main', 2],
      ['helper', 3],
    ]);
    expect(usage.total).toEqual(figures(5));
  });

  it('changes nothing for the channel’s opening', () => {
    const usage = fold([used({ cursor: 1, node: 'main', calls: 1, total: 1 })]);

    expect(applyUsageEntry({ usage, entry: opened })).toBe(usage);
  });

  it('makes the total a lower bound for an opening that says earlier calls went uncounted, and keeps it so as calls come', () => {
    const uncounted = usageChannelEntrySchema.parse({
      channel: 'usage',
      cursor: 's0',
      at: 0,
      type: 'opened',
      earlierUncounted: true,
    });
    const start = applyUsageEntry({ usage: emptyUsage(), entry: uncounted });

    expect(start.total).toEqual({ ...emptyUsageFigures(), incomplete: true });
    expect(start.nodes).toEqual([]);
    // The next entry says what the total now is, which the writer makes of the same start.
    expect(
      applyUsageEntry({
        usage: start,
        entry: usageChannelEntrySchema.parse({
          channel: 'usage',
          cursor: 's1',
          at: 1,
          type: 'node_usage',
          usage: { ...figures(1), node: 'main' },
          total: { ...figures(1), incomplete: true },
        }),
      }).total.incomplete,
    ).toBe(true);
  });

  it('gives the same usage for an entry told twice as for once: an entry says what it now is', () => {
    const once = fold(LOG);
    const twice = fold([...LOG, ...LOG.slice(-2)]);

    expect(twice).toEqual(once);
  });

  it('drops the records of the nodes an entry says are no longer kept, and takes its total: their calls are in it', () => {
    const evicting = usageChannelEntrySchema.parse({
      channel: 'usage',
      cursor: 's5',
      at: 5,
      type: 'node_usage',
      usage: { ...figures(1), node: 'third' },
      total: figures(6),
      evicted: ['helper'],
    });
    const usage = fold([...LOG, evicting]);

    expect(usage.nodes.map(({ node }) => node)).toEqual(['main', 'third']);
    expect(usage.total).toEqual(figures(6));
  });

  it('keeps the node an entry is about even when it lists it as evicted', () => {
    const odd = usageChannelEntrySchema.parse({
      channel: 'usage',
      cursor: 's5',
      at: 5,
      type: 'node_usage',
      usage: { ...figures(4), node: 'helper' },
      total: figures(6),
      evicted: ['helper'],
    });

    expect(fold([...LOG, odd]).nodes.map(({ node, calls }) => [node, calls])).toEqual([
      ['main', 2],
      ['helper', 4],
    ]);
  });

  it('gives, from a snapshot and the entries after its cursor, what every entry from the start gives', () => {
    for (let at = 0; at < LOG.length; at += 1) {
      const covered = fold(LOG.slice(0, at + 1));
      const snapshot = usageSnapshotOf({ usage: covered, cursor: `s${String(at)}`, at });
      const resumed = fold(LOG.slice(at + 1), { total: snapshot.total, nodes: snapshot.nodes });

      expect(resumed, `from a snapshot at s${String(at)}`).toEqual(fold(LOG));
    }
  });
});

describe('usageSnapshotOf', () => {
  it('is a snapshot the schema takes, of the usage at a cursor', () => {
    const snapshot = usageSnapshotOf({ usage: fold(LOG), cursor: 's4', at: 4 });

    expect(usageSnapshotSchema.parse(snapshot)).toEqual(snapshot);
    expect(snapshot).toMatchObject({ channel: 'usage', cursor: 's4', type: 'snapshot' });
  });

  it('is empty for a conversation that made no call', () => {
    expect(usageSnapshotOf({ usage: emptyUsage(), cursor: 's0', at: 0 })).toMatchObject({
      total: emptyUsageFigures(),
      nodes: [],
    });
  });
});

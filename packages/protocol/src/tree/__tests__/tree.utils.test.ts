import { describe, expect, it } from 'vitest';
import { MAX_TREE_NODES } from '../../node/node.constants.js';
import { treeChannelEntrySchema, treeSnapshotSchema } from '../tree.validator.js';
import type { TreeChannelEntry, TreeView } from '../tree.types.js';
import { applyTreeEntry, emptyTree, treeSnapshotOf } from '../tree.utils.js';

const MESSAGE_ID = '0f8fad5b-d9cb-469f-a165-70867728950e';
const MAIN = { kind: 'agent', id: 'main', title: 'Main', state: 'running', startedAt: 1 };
const CHILD = {
  kind: 'agent',
  id: 'child',
  parent: 'main',
  title: 'Reader',
  state: 'running',
  startedAt: 3,
};
const SERVICE = {
  kind: 'service',
  id: 'dev-server',
  parent: 'main',
  title: 'npm run dev',
  command: 'npm run dev',
  description: 'The dev server',
  output: '',
  state: 'running',
  startedAt: 5,
};
const request = (id: string) => ({
  id,
  callId: `call-${id}`,
  tool: 'run_command',
  command: 'git push',
  concerns: [],
  options: ['approve', 'skip'],
});

/** One entry of the tree channel at `position`; `more` is what its type holds. */
function entry(params: { position: number; type: string; more?: object }): TreeChannelEntry {
  return treeChannelEntrySchema.parse({
    channel: 'tree',
    cursor: `s${String(params.position)}`,
    at: 10 + params.position,
    type: params.type,
    ...params.more,
  });
}

/**
 * A conversation's tree channel from its start: the main agent, a sub-agent that asks for an
 * approval and is answered, a service that is still running, a second approval still waiting, and
 * notices that change nothing in the tree.
 */
const LOG: TreeChannelEntry[] = [
  entry({ position: 0, type: 'opened' }),
  entry({ position: 1, type: 'node_opened', more: { node: MAIN } }),
  entry({ position: 2, type: 'node_opened', more: { node: CHILD } }),
  entry({
    position: 3,
    type: 'approval_requested',
    more: { node: 'child', request: request('a1') },
  }),
  entry({ position: 4, type: 'queue_changed', more: { queued: ['next'] } }),
  entry({
    position: 5,
    type: 'approval_resolved',
    more: { node: 'child', id: 'a1', response: { decision: 'approve' } },
  }),
  entry({ position: 6, type: 'node_opened', more: { node: SERVICE } }),
  entry({
    position: 7,
    type: 'node_updated',
    more: { node: { ...MAIN, state: 'idle', status: 'waiting' } },
  }),
  entry({
    position: 8,
    type: 'approval_requested',
    more: { node: 'main', request: request('a2') },
  }),
  entry({
    position: 9,
    type: 'prompt_started',
    more: { text: 'go', messageId: MESSAGE_ID, queued: [] },
  }),
  entry({
    position: 10,
    type: 'node_closed',
    more: {
      node: { ...CHILD, state: 'completed', endedAt: 20, lastOutcome: 'completed' },
    },
  }),
  entry({ position: 11, type: 'storage_failed', more: { error: 'disk full' } }),
];

/** Every entry of `entries` folded, in order. */
const replay = (entries: readonly TreeChannelEntry[]): TreeView =>
  entries.reduce((tree, next) => applyTreeEntry({ tree, entry: next }), emptyTree());

describe('the tree the entries of its channel make', () => {
  it('starts empty', () => {
    expect(emptyTree()).toEqual({ nodes: [], approvals: [] });
  });

  it('has every node as its last entry says, in the order they opened, ended ones kept', () => {
    const { nodes } = replay(LOG);

    expect(nodes.map(({ id, state }) => `${id} ${state}`)).toEqual([
      'main idle',
      'child completed',
      'dev-server running',
    ]);
    expect(nodes[0]).toMatchObject({ status: 'waiting' });
  });

  it('has the approvals still waiting, and not the one that was answered', () => {
    expect(replay(LOG).approvals.map(({ node, request: asked }) => [node, asked.id])).toEqual([
      ['main', 'a2'],
    ]);
  });

  it('drops an approval that was given up, as it drops one that was answered', () => {
    const asked = entry({
      position: 1,
      type: 'approval_requested',
      more: { node: 'main', request: request('a1') },
    });
    const gone = entry({
      position: 2,
      type: 'approval_cancelled',
      more: { node: 'main', id: 'a1' },
    });

    expect(replay([asked]).approvals).toHaveLength(1);
    expect(replay([asked, gone]).approvals).toEqual([]);
  });

  it('is changed by no entry that is only shown: the channel’s own, a notice, an extension’s event', () => {
    const shown = [
      entry({ position: 0, type: 'opened' }),
      entry({ position: 1, type: 'queue_changed', more: { queued: ['one'] } }),
      entry({ position: 2, type: 'prompt_refused', more: { text: 'x', error: 'no', queued: [] } }),
      entry({ position: 3, type: 'storage_failed', more: { error: 'disk' } }),
      entry({
        position: 4,
        type: 'extension_event',
        more: { extension: 'notes', kind: 'notes.sync', version: 1, data: {}, text: 'Synced' },
      }),
      entry({ position: 5, type: 'closed' }),
    ];

    expect(replay(shown)).toEqual(emptyTree());
  });

  it('folds an entry without changing the tree it was given', () => {
    const before = replay(LOG.slice(0, 4));
    const frozen = structuredClone(before);

    applyTreeEntry({ tree: before, entry: LOG[4] ?? LOG[0]! });
    applyTreeEntry({ tree: before, entry: LOG[5] ?? LOG[0]! });

    expect(before).toEqual(frozen);
  });

  it('adds a node it has never seen whatever the entry is, and asks the same approval once', () => {
    const lateClose = entry({
      position: 5,
      type: 'node_closed',
      more: { node: { ...CHILD, state: 'completed', endedAt: 9, lastOutcome: 'completed' } },
    });
    const again = entry({
      position: 6,
      type: 'approval_requested',
      more: { node: 'child', request: request('a1') },
    });

    expect(replay([lateClose]).nodes.map(({ id }) => id)).toEqual(['child']);
    expect(replay([again, again]).approvals).toHaveLength(1);
  });
});

/** The snapshot of `LOG` taken after the entry at position `upTo`: what a client that connects then gets. */
function snapshotAfter(upTo: number) {
  const covered = LOG.slice(0, upTo + 1);
  const last = covered.at(-1);

  return treeSnapshotOf({
    tree: replay(covered),
    cursor: last?.cursor ?? 's0',
    at: last?.at ?? 0,
  });
}

describe('a snapshot and the entries after it', () => {
  it.each(LOG.map((_each, upTo) => [upTo]))(
    'give the tree of every entry from the start, taken after entry %i',
    (upTo) => {
      const { nodes, approvals } = snapshotAfter(upTo);
      const continued = LOG.slice(upTo + 1).reduce(
        (tree, next) => applyTreeEntry({ tree, entry: next }),
        { nodes, approvals },
      );

      expect(continued).toEqual(replay(LOG));
    },
  );

  it.each(LOG.map((_each, upTo) => [upTo]))(
    'is a snapshot the contract accepts after entry %i, whatever the log has done so far',
    (upTo) => {
      expect(treeSnapshotSchema.safeParse(snapshotAfter(upTo)).success).toBe(true);
    },
  );

  it('says it is the tree channel’s, at the cursor it was taken, and is not an entry', () => {
    const snapshot = treeSnapshotOf({ tree: replay(LOG), cursor: 's11', at: 21 });

    expect(snapshot).toMatchObject({ channel: 'tree', cursor: 's11', at: 21, type: 'snapshot' });
    expect(treeChannelEntrySchema.safeParse(snapshot).success).toBe(false);
  });
});

describe('a tree that outgrows what a snapshot holds', () => {
  /** A sub-agent of `main` that opened and ended, as the entries of its life say. */
  const lived = (index: number) => {
    const node = {
      ...CHILD,
      id: `sub-${String(index)}`,
      state: 'completed',
      endedAt: 9,
      lastOutcome: 'completed',
    };

    return entry({ position: 2 + index, type: 'node_closed', more: { node } });
  };

  /** The main agent, then `count` sub-agents that each lived and ended. */
  const manyLives = (count: number) => [
    entry({ position: 1, type: 'node_opened', more: { node: MAIN } }),
    ...Array.from({ length: count }, (_each, index) => lived(index)),
  ];

  it('keeps the newest ended nodes and everything that runs, within what a snapshot holds', () => {
    const tree = replay(manyLives(MAX_TREE_NODES + 5));
    const ids = tree.nodes.map(({ id }) => id);

    expect(tree.nodes).toHaveLength(MAX_TREE_NODES);
    expect(ids).toContain('main');
    // The main agent and five more than fit: the oldest six ended ones are the ones that went.
    expect(ids).not.toContain('sub-0');
    expect(ids).not.toContain('sub-5');
    expect(ids).toContain('sub-6');
    expect(ids.at(-1)).toBe(`sub-${String(MAX_TREE_NODES + 4)}`);
    expect(
      treeSnapshotSchema.safeParse(treeSnapshotOf({ tree, cursor: 's2000', at: 1 })).success,
    ).toBe(true);
  });

  it('never drops a node another still needs: a parent stays while a node under it does', () => {
    const grandparent = {
      ...CHILD,
      id: 'grandparent',
      parent: 'main',
      state: 'completed',
      endedAt: 9,
      lastOutcome: 'completed',
    };
    const under = { ...grandparent, id: 'under', parent: 'grandparent' };
    // The two oldest ended nodes: the parent first, then what hangs from it, then many leaves.
    const log = [
      entry({ position: 1, type: 'node_opened', more: { node: MAIN } }),
      entry({ position: 2, type: 'node_closed', more: { node: grandparent } }),
      entry({ position: 3, type: 'node_closed', more: { node: under } }),
      ...Array.from({ length: MAX_TREE_NODES - 2 }, (_each, index) => lived(10 + index)),
    ];
    const tree = replay(log);
    const ids = tree.nodes.map(({ id }) => id);

    expect(tree.nodes).toHaveLength(MAX_TREE_NODES);
    // `grandparent` is older than any leaf but has `under` hanging from it: `under` goes first.
    expect(ids).toContain('grandparent');
    expect(ids).not.toContain('under');
    expect(
      treeSnapshotSchema.safeParse(treeSnapshotOf({ tree, cursor: 's2', at: 1 })).success,
    ).toBe(true);
  });

  it('keeps a node that still runs however old, and a snapshot taken then still continues to the same tree', () => {
    const log = manyLives(MAX_TREE_NODES + 50);
    const upTo = MAX_TREE_NODES + 10;
    const snapshot = replay(log.slice(0, upTo));
    const continued = log
      .slice(upTo)
      .reduce((tree, next) => applyTreeEntry({ tree, entry: next }), snapshot);

    expect(replay(log).nodes.map(({ id }) => id)).toContain('main');
    expect(continued).toEqual(replay(log));
  });
});

import { describe, expect, it } from 'vitest';
import { conversationIdSchema } from '@sheavly/protocol/server/server.validator';
import type { TreeView } from '@sheavly/protocol/tree/tree.types';
import { emptyTree } from '@sheavly/protocol/tree/tree.utils';
import { AnswerError, ChannelFailedError, RefusedError } from '../../errors/client.errors.js';
import {
  agentNode,
  agentUpdated,
  approvalRequest,
  endedAs,
  serviceNode,
  treeEntry,
  treeSnapshot,
} from '../../testing/frames.fake.js';
import { DROP, served } from '../../testing/subscription-server.fake.js';
import type { FakeRefusal, SentFrames, ServedSubscription } from '../../testing/testing.types.js';
import type { TreeEntryListener } from '../tree.types.js';
import { watchTree } from '../watch-tree.helper.js';

const ID = conversationIdSchema.parse('00000000-0000-4000-8000-0000000000ab');

const MAIN = agentNode({ id: 'main' });
const OPENED = treeEntry({
  n: 2,
  type: 'node_opened',
  fields: { node: serviceNode({ id: 'dev' }) },
});
const CLOSED = treeEntry({
  n: 3,
  type: 'node_closed',
  fields: { node: serviceNode({ id: 'dev', state: 'cancelled' }) },
});
const OVER = endedAs({ name: 'tree', reason: 'completed' });

/**
 * The connections of a server whose first one drops after the entry `OPENED`, and which no longer
 * holds the position it is then asked from: what it sends after that is `again`.
 */
const losingItsPosition = (again: SentFrames): (SentFrames | FakeRefusal)[] => [
  [treeSnapshot({ n: 1, nodes: [MAIN] }), OPENED, DROP],
  { refuse: { status: 422, code: 'cursor_out_of_range' } },
  again,
];

/** Watches the tree to its end, and answers the tree it ended with and each tree it was told of. */
async function watched(params: { world: ServedSubscription; approvals?: boolean }) {
  const changes: TreeView[] = [];
  const watch = await watchTree({
    client: params.world.client,
    id: ID,
    onChange: (tree) => changes.push(tree),
    signal: new AbortController().signal,
    ...(params.approvals !== undefined && { approvals: params.approvals }),
  });

  await watch.ended;

  return { tree: watch.tree(), changes };
}

/** Watches the tree to its end, and answers the log of what `onEntry` and `onChange` were told. */
async function watchedEntries(params: { world: ServedSubscription; onEntry?: TreeEntryListener }) {
  const log: string[] = [];
  const entries: Parameters<TreeEntryListener>[0][] = [];
  const watch = await watchTree({
    client: params.world.client,
    id: ID,
    onChange: () => log.push('change'),
    onEntry: (told) => {
      entries.push(told);
      log.push(told.entry.type);
      params.onEntry?.(told);
    },
    signal: new AbortController().signal,
  });

  await watch.ended;

  return { log, entries };
}

/** Starts watching a tree whose server sends `entries` after the snapshot with the main agent. */
async function flooded(entries: ReturnType<typeof treeEntry>[]) {
  const world = served({
    connections: [[treeSnapshot({ n: 1, nodes: [MAIN] }), ...entries, OVER]],
  });
  const told: TreeView[] = [];
  const watch = await watchTree({
    client: world.client,
    id: ID,
    approvals: true,
    onChange: (tree) => told.push(tree),
    signal: new AbortController().signal,
  });

  return { watch, told, world };
}

/** A tree as a test reads it: each node's id and state, and the ids of the approvals that wait. */
const summary = (tree: TreeView) => ({
  nodes: tree.nodes.map(({ id, state }) => `${id} ${state}`),
  approvals: tree.approvals.map(({ request }) => request.id),
});

describe('watchTree', () => {
  it('is the snapshot with each entry folded in, and tells of each change but one that changes nothing', async () => {
    const world = served({
      connections: [
        [
          treeSnapshot({ n: 1, nodes: [MAIN] }),
          OPENED,
          CLOSED,
          // The queue is not in the tree: this entry changes nothing.
          treeEntry({ n: 4, type: 'queue_changed', fields: { queued: ['next'] } }),
          OVER,
        ],
      ],
    });

    const { tree, changes } = await watched({ world });

    expect(summary(tree)).toEqual({ nodes: ['main idle', 'dev cancelled'], approvals: [] });
    expect(changes.map((each) => each.nodes.length)).toEqual([1, 2, 2]);
    expect(world.asked()).toEqual([{ subscriptions: [{ channel: 'tree', from: 'snapshot' }] }]);
  });

  it('is, after a reconnect, the tree a snapshot of that moment gives', async () => {
    const asks = { node: 'main', request: approvalRequest('a-1') };
    const resumed = served({
      connections: [
        [treeSnapshot({ n: 1, nodes: [MAIN] }), OPENED, DROP],
        [CLOSED, treeEntry({ n: 4, type: 'approval_requested', fields: asks }), OVER],
      ],
    });
    // A watcher that connects after all of it, and starts from the snapshot.
    const fresh = served({
      connections: [
        [
          treeSnapshot({
            n: 4,
            nodes: [MAIN, serviceNode({ id: 'dev', state: 'cancelled' })],
            approvals: [asks],
          }),
          OVER,
        ],
      ],
    });

    const { tree } = await watched({ world: resumed });

    expect(tree).toEqual((await watched({ world: fresh })).tree);
    // It went on after the last entry it had, and did not ask for the snapshot again.
    expect(resumed.asked()[1]).toEqual({ subscriptions: [{ channel: 'tree', from: 's2' }] });
  });

  it('asks again from the snapshot when the server no longer holds its position, and the tree it gives replaces its own', async () => {
    const world = served({
      connections: losingItsPosition([treeSnapshot({ n: 9, nodes: [MAIN] }), OVER]),
    });

    const { tree, changes } = await watched({ world });

    // `dev` was in the tree it had, and is not in the one the server gives now.
    expect(summary(tree)).toEqual({ nodes: ['main idle'], approvals: [] });
    expect(changes.map((each) => each.nodes.length)).toEqual([1, 2, 1]);
    expect(world.asked().map(({ subscriptions }) => subscriptions[0]?.from)).toEqual([
      'snapshot',
      's2',
      'snapshot',
    ]);
  });

  it('shows the approvals that wait, and says it answers them when it is asked to', async () => {
    const asks = { node: 'main', request: approvalRequest('a-1') };
    const world = served({
      connections: [
        [
          treeSnapshot({ n: 1, nodes: [MAIN] }),
          treeEntry({ n: 2, type: 'approval_requested', fields: asks }),
          treeEntry({
            n: 3,
            type: 'approval_resolved',
            fields: { node: 'main', id: 'a-1', response: { decision: 'approve' } },
          }),
          OVER,
        ],
      ],
    });

    const { changes } = await watched({ world, approvals: true });

    expect(changes.map((each) => summary(each).approvals)).toEqual([[], ['a-1'], []]);
    expect(world.asked()[0]).toEqual({
      subscriptions: [{ channel: 'tree', from: 'snapshot' }],
      approvals: true,
    });
  });

  it('rejects `ended` when the tree channel ends failed (its conversation closed): nothing more will come, and the claim is gone', async () => {
    const world = served({
      connections: [
        [treeSnapshot({ n: 1, nodes: [MAIN] }), endedAs({ name: 'tree', reason: 'failed' })],
      ],
    });

    await expect(watched({ world, approvals: true })).rejects.toBeInstanceOf(ChannelFailedError);
    // It does not ask again: a channel that failed is not one the server will go on with.
    expect(world.asked()).toHaveLength(1);
  });

  it('refuses a server that sends more waiting approvals than a snapshot may hold, keeps the tree it had and is not asked again', async () => {
    const asked = Array.from({ length: 1_001 }, (_, index) =>
      treeEntry({
        n: index + 2,
        type: 'approval_requested',
        fields: { node: 'main', request: approvalRequest(`a-${String(index)}`) },
      }),
    );
    const { watch, told, world } = await flooded(asked);

    await expect(watch.ended).rejects.toBeInstanceOf(AnswerError);
    // The 1,001st was refused before it was kept or told of.
    expect(watch.tree().approvals).toHaveLength(1_000);
    expect(told.at(-1)?.approvals).toHaveLength(1_000);
    expect(world.asked()).toHaveLength(1);
  });

  it('refuses a server that sends more nodes than a snapshot may hold: open nodes are never dropped by the rule, so it would keep them all', async () => {
    // The main agent and a thousand services that go on running: a thousand and one nodes.
    const opened = Array.from({ length: 1_000 }, (_, index) =>
      treeEntry({
        n: index + 2,
        type: 'node_opened',
        fields: { node: serviceNode({ id: `s-${String(index)}` }) },
      }),
    );
    const { watch, told, world } = await flooded(opened);

    await expect(watch.ended).rejects.toBeInstanceOf(AnswerError);
    expect(watch.tree().nodes).toHaveLength(1_000);
    expect(told.at(-1)?.nodes).toHaveLength(1_000);
    expect(world.asked()).toHaveLength(1);
  });

  it('rejects `ended` with a refusal that asking again would not change', async () => {
    const world = served({
      connections: [
        [treeSnapshot({ n: 1, nodes: [MAIN] }), DROP],
        { refuse: { status: 404, code: 'not_found' } },
      ],
    });

    await expect(watched({ world })).rejects.toBeInstanceOf(RefusedError);
  });

  it('rejects at once when the server refuses the first connection', async () => {
    const world = served({ connections: [{ refuse: { status: 404, code: 'not_found' } }] });

    await expect(watched({ world })).rejects.toBeInstanceOf(RefusedError);
  });

  it('ends quietly when its signal aborts, with the tree it had', async () => {
    const world = served({ connections: [[treeSnapshot({ n: 1, nodes: [MAIN] })]] });
    const stop = new AbortController();
    const told = Promise.withResolvers<undefined>();
    const watch = await watchTree({
      client: world.client,
      id: ID,
      onChange: () => told.resolve(undefined),
      signal: stop.signal,
    });

    await told.promise;
    stop.abort();
    await watch.ended;

    expect(summary(watch.tree()).nodes).toEqual(['main idle']);
  });
});

/** Every entry kind of the tree channel after the snapshot (its opening is before it), as entries 2 to 14. */
const EVERY_KIND = [
  OPENED,
  treeEntry({ n: 3, type: 'node_updated', fields: { node: serviceNode({ id: 'dev' }) } }),
  treeEntry({
    n: 4,
    type: 'approval_requested',
    fields: { node: 'main', request: approvalRequest('a-1') },
  }),
  treeEntry({
    n: 5,
    type: 'approval_resolved',
    fields: { node: 'main', id: 'a-1', response: { decision: 'approve' } },
  }),
  treeEntry({
    n: 6,
    type: 'approval_requested',
    fields: { node: 'main', request: approvalRequest('a-2') },
  }),
  treeEntry({ n: 7, type: 'approval_cancelled', fields: { node: 'main', id: 'a-2' } }),
  treeEntry({ n: 8, type: 'queue_changed', fields: { queued: ['next'] } }),
  treeEntry({
    n: 9,
    type: 'prompt_started',
    fields: { text: 'go', messageId: '00000000-0000-4000-8000-000000000009', queued: [] },
  }),
  treeEntry({
    n: 10,
    type: 'prompt_refused',
    fields: {
      text: 'rm',
      messageId: '00000000-0000-4000-8000-000000000010',
      error: 'no skill',
      queued: [],
    },
  }),
  treeEntry({ n: 11, type: 'storage_failed', fields: { error: 'disk full' } }),
  treeEntry({
    n: 12,
    type: 'extension_event',
    fields: { extension: 'demo', kind: 'demo.note', version: 1, data: {}, text: 'a note' },
  }),
  treeEntry({
    n: 13,
    type: 'node_closed',
    fields: { node: serviceNode({ id: 'dev', state: 'cancelled' }) },
  }),
  treeEntry({ n: 14, type: 'closed' }),
];

describe('watchTree: onEntry', () => {
  it('tells of every entry once, in channel order, before the change it makes, with the tree before and after', async () => {
    const world = served({
      connections: [[treeSnapshot({ n: 1, nodes: [MAIN] }), ...EVERY_KIND, OVER]],
    });

    const { log, entries } = await watchedEntries({ world });

    expect(entries.map(({ entry }) => entry.type)).toEqual(EVERY_KIND.map((each) => each.type));
    // An entry is told before the change it makes, and a change is told only for a tree that changed.
    expect(log).toEqual([
      'change', // the snapshot
      'node_opened',
      'change',
      'node_updated',
      'change',
      'approval_requested',
      'change',
      'approval_resolved',
      'change',
      'approval_requested',
      'change',
      'approval_cancelled',
      'change',
      'queue_changed',
      'prompt_started',
      'prompt_refused',
      'storage_failed',
      'extension_event',
      'node_closed',
      'change',
      'closed',
    ]);
    // What changes nothing in the tree has the same tree before and after, and the rest does not.
    expect(entries.map(({ before, after }) => before === after)).toEqual([
      false,
      false,
      false,
      false,
      false,
      false,
      true,
      true,
      true,
      true,
      true,
      false,
      true,
    ]);
    expect(summary(entries[0]?.before ?? emptyTree()).nodes).toEqual(['main idle']);
    expect(summary(entries[0]?.after ?? emptyTree()).nodes).toEqual(['main idle', 'dev running']);
  });

  it('does not tell of the snapshot or of another channel’s frame', async () => {
    const world = served({
      connections: [
        [
          treeSnapshot({ n: 1, nodes: [MAIN] }),
          agentUpdated({ name: 'main', n: 2 }),
          treeEntry({ n: 3, type: 'queue_changed', fields: { queued: ['next'] } }),
          OVER,
        ],
      ],
    });

    const { entries } = await watchedEntries({ world });

    expect(entries.map(({ entry }) => `${entry.type} ${entry.cursor}`)).toEqual([
      'queue_changed s3',
    ]);
  });

  it('tells no entry twice when a dropped connection resumes after the last one', async () => {
    const world = served({
      connections: [
        [treeSnapshot({ n: 1, nodes: [MAIN] }), OPENED, DROP],
        [CLOSED, OVER],
      ],
    });

    const { entries } = await watchedEntries({ world });

    expect(entries.map(({ entry }) => entry.cursor)).toEqual(['s2', 's3']);
    expect(world.asked()[1]).toEqual({ subscriptions: [{ channel: 'tree', from: 's2' }] });
  });

  it('does not tell of the entries in the gap when the server no longer holds its position: the snapshot replaces the tree', async () => {
    const world = served({
      connections: losingItsPosition([
        treeSnapshot({ n: 9, nodes: [MAIN] }),
        treeEntry({ n: 10, type: 'queue_changed', fields: { queued: [] } }),
        OVER,
      ]),
    });

    const { entries } = await watchedEntries({ world });

    expect(entries.map(({ entry }) => entry.cursor)).toEqual(['s2', 's10']);
  });

  it('rejects `ended` with what the hook throws, and tells no more', async () => {
    const failure = new Error('the hook failed');
    const world = served({
      connections: [[treeSnapshot({ n: 1, nodes: [MAIN] }), OPENED, CLOSED, OVER]],
    });
    let calls = 0;

    await expect(
      watchedEntries({
        world,
        onEntry: () => {
          calls += 1;

          throw failure;
        },
      }),
    ).rejects.toBe(failure);
    expect(calls).toBe(1);
    // It is the end of the channel's following: nothing is asked again.
    expect(world.asked()).toHaveLength(1);
  });
});

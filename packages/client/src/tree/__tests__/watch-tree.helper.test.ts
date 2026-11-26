import { describe, expect, it } from 'vitest';
import { conversationIdSchema } from '@sheavly/protocol/server/server.validator';
import type { TreeView } from '@sheavly/protocol/tree/tree.types';
import { AnswerError, ChannelFailedError, RefusedError } from '../../errors/client.errors.js';
import {
  agentNode,
  approvalRequest,
  endedAs,
  serviceNode,
  treeEntry,
  treeSnapshot,
} from '../../testing/frames.fake.js';
import { DROP, served } from '../../testing/subscription-server.fake.js';
import type { ServedSubscription } from '../../testing/testing.types.js';
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
      connections: [
        [treeSnapshot({ n: 1, nodes: [MAIN] }), OPENED, DROP],
        { refuse: { status: 422, code: 'cursor_out_of_range' } },
        [treeSnapshot({ n: 9, nodes: [MAIN] }), OVER],
      ],
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

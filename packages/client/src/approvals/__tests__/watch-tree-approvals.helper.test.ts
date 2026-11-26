import { describe, expect, it } from 'vitest';
import type { ApprovalId } from '@sheavly/protocol/approval/approval.types';
import { conversationIdSchema } from '@sheavly/protocol/server/server.validator';
import {
  agentNode,
  approvalRequest,
  endedAs,
  treeEntry,
  treeSnapshot,
} from '../../testing/frames.fake.js';
import { DROP, served } from '../../testing/subscription-server.fake.js';
import type { ServedSubscription } from '../../testing/testing.types.js';
import type { TreeApproval } from '../approvals.types.js';
import { watchTreeApprovals } from '../watch-tree-approvals.helper.js';

const ID = conversationIdSchema.parse('00000000-0000-4000-8000-0000000000ab');

const MAIN = agentNode({ id: 'main' });
const OVER = endedAs({ name: 'tree', reason: 'completed' });

/** An entry saying `node` asked for approval `id`: number `n` of the tree channel. */
const asked = (params: { n: number; node?: string; id: string }) =>
  treeEntry({
    n: params.n,
    type: 'approval_requested',
    fields: { node: params.node ?? 'main', request: approvalRequest(params.id) },
  });

/** An entry saying approval `id` was answered. */
const answered = (params: { n: number; id: string }) =>
  treeEntry({
    n: params.n,
    type: 'approval_resolved',
    fields: { node: 'main', id: params.id, response: { decision: 'approve' } },
  });

/** The snapshot of a tree with the main agent, and two approvals asked after it. */
const TWO_ASKED = [
  treeSnapshot({ n: 1, nodes: [MAIN] }),
  asked({ n: 2, id: 'a-1' }),
  asked({ n: 3, id: 'a-2' }),
];

/** Watches the approvals to the end of the tree channel; answers what it was told, in order. */
async function heard(world: ServedSubscription) {
  const told: TreeApproval[] = [];
  const gone: ApprovalId[] = [];
  const watch = await watchTreeApprovals({
    client: world.client,
    id: ID,
    onApproval: (approval) => told.push(approval),
    onGone: (id) => gone.push(id),
    signal: new AbortController().signal,
  });

  await watch.ended;

  return { told, gone };
}

describe('watchTreeApprovals', () => {
  it('says it answers approvals, and tells of an approval already waiting when it connects, with the node that asked', async () => {
    const world = served({
      connections: [
        [
          treeSnapshot({
            n: 1,
            nodes: [MAIN],
            approvals: [{ node: 'main', request: approvalRequest('a-1') }],
          }),
          OVER,
        ],
      ],
    });

    const { told, gone } = await heard(world);

    expect(world.asked()[0]).toEqual({
      subscriptions: [{ channel: 'tree', from: 'snapshot' }],
      approvals: true,
    });
    expect(told).toHaveLength(1);
    expect(told[0]).toMatchObject({
      node: 'main',
      asker: { kind: 'agent', id: 'main' },
      request: { id: 'a-1', tool: 'run_command' },
    });
    expect(gone).toEqual([]);
  });

  it('tells of an approval once when it is asked, and when it no longer waits', async () => {
    const world = served({
      connections: [
        [
          ...TWO_ASKED,
          answered({ n: 4, id: 'a-1' }),
          treeEntry({
            n: 5,
            type: 'approval_cancelled',
            fields: { node: 'main', id: 'a-2' },
          }),
          OVER,
        ],
      ],
    });

    const { told, gone } = await heard(world);

    expect(told.map(({ request }) => request.id)).toEqual(['a-1', 'a-2']);
    expect(gone).toEqual(['a-1', 'a-2']);
  });

  it('does not tell again of an approval it was told of, after a reconnect, and tells of one that went meanwhile', async () => {
    const world = served({
      connections: [
        [...TWO_ASKED, DROP],
        // Resumed after the last entry: a-1 was answered while it was down, and a-3 was asked.
        [answered({ n: 4, id: 'a-1' }), asked({ n: 5, id: 'a-3' }), OVER],
      ],
    });

    const { told, gone } = await heard(world);

    expect(told.map(({ request }) => request.id)).toEqual(['a-1', 'a-2', 'a-3']);
    expect(gone).toEqual(['a-1']);
    expect(world.asked()[1]).toEqual({
      subscriptions: [{ channel: 'tree', from: 's3' }],
      approvals: true,
    });
  });

  it('has no node for the approval of a node the tree no longer holds', async () => {
    const world = served({
      connections: [
        [
          treeSnapshot({ n: 1, nodes: [MAIN] }),
          asked({ n: 2, node: 'gone-agent', id: 'a-1' }),
          OVER,
        ],
      ],
    });

    const { told } = await heard(world);

    expect(told[0]).toMatchObject({ node: 'gone-agent', asker: undefined });
  });
});

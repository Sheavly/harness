import {
  agentNode,
  approvalRequest,
  treeEntry,
  treeSnapshot,
} from '@sheavly/client/testing/frames.fake';
import type { SubscribeFrame } from '@sheavly/protocol/subscription/subscription.types';
import { liveFeed } from './live-feed.fake.js';

/**
 * Test-only: a conversation's tree as a backend sends it to a subscriber of the tree channel: the
 * snapshot of the tree as it stands (the main agent, and what `nodes` adds), then each entry
 * published after, in order. Its stream never ends of its own, as the tree channel's does not. A
 * fake server's `streamChannels` answers with `follow()`.
 */
export function treeFeed(nodes: object[] = []) {
  const feed = liveFeed<SubscribeFrame>();
  let n = 1;

  function follow(): AsyncGenerator<SubscribeFrame> {
    // The snapshot is as the tree stands when the subscription opens, and what is published after
    // that is kept for it, so an entry told before the client reads its first frame is not lost
    // and never numbers below the snapshot's cursor.
    const snapshot = treeSnapshot({ n, nodes: [MAIN_AGENT, ...nodes] });
    const live = feed.follow();

    async function* read(): AsyncGenerator<SubscribeFrame> {
      yield snapshot;
      yield* live;
    }

    return read();
  }

  return {
    follow,
    /** Tells subscribers a node opened. */
    opened: (node: object) => {
      n += 1;
      feed.publish(treeEntry({ n, type: 'node_opened', fields: { node } }));
    },
    /** Tells subscribers a node ended, in the state `node` has. */
    closed: (node: object) => {
      n += 1;
      feed.publish(treeEntry({ n, type: 'node_closed', fields: { node } }));
    },
    /** Tells subscribers the tree channel failed, as it does when its conversation closes. */
    failed: () => feed.publish(endedAs({ name: 'tree', reason: 'failed' })),
    /** Tells subscribers an approval is asked by `node`. */
    asked: (params: { node?: string; id: string }) => {
      n += 1;
      feed.publish(
        treeEntry({
          n,
          type: 'approval_requested',
          fields: { node: params.node ?? 'main', request: approvalRequest(params.id) },
        }),
      );
    },
    /** Tells subscribers an approval was answered (`approve`). */
    answered: (params: { node?: string; id: string }) => {
      n += 1;
      feed.publish(
        treeEntry({
          n,
          type: 'approval_resolved',
          fields: {
            node: params.node ?? 'main',
            id: params.id,
            response: { decision: 'approve' },
          },
        }),
      );
    },
  };
}

/** Test-only: the main agent, the node with no parent, running. */
export const MAIN_AGENT = agentNode({ id: 'main', state: 'running' });

/**
 * Test-only: a node under the main agent: a command, a service or a sub-agent, running unless
 * `state` says how it ended.
 */
export function childNode(params: {
  id: string;
  kind: 'command' | 'service' | 'agent';
  state?: 'running' | 'completed';
}) {
  const { id, kind, state = 'running' } = params;
  const common = {
    id,
    kind,
    parent: 'main',
    title: id,
    state,
    startedAt: 1,
    ...(state !== 'running' && { endedAt: 3 }),
  };

  if (kind === 'agent') {
    return { ...common, ...(state !== 'running' && { lastOutcome: 'completed' }) };
  }

  return { ...common, command: 'make', description: 'build', output: '' };
}

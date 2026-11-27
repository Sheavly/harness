import {
  agentNode,
  approvalRequest,
  endedAs,
  treeEntry,
  treeSnapshot,
} from '@sheavly/client/testing/frames.fake';
import type { FakeHandlers } from '@sheavly/client/testing/testing.types';
import type { SubscribeFrame } from '@sheavly/protocol/subscription/subscription.types';
import { treeSnapshotSchema } from '@sheavly/protocol/tree/tree.validator';
import { liveFeed } from './live-feed.fake.js';

/**
 * Test-only: a conversation's tree as a backend sends it to a subscriber of the tree channel: the
 * snapshot of the tree as it stands (the main agent, and what `nodes` adds), then each entry
 * published after, in order. Its stream never ends of its own, as the tree channel's does not. A
 * fake server's `streamChannels` answers with `follow()`. `mains` are the agents with no parent the
 * snapshot starts with: the one main agent, unless a test says what a reopened conversation holds.
 */
export function treeFeed(nodes: object[] = [], mains: object[] = [MAIN_AGENT]) {
  const feed = liveFeed<SubscribeFrame>();
  let n = 1;

  function follow(): AsyncGenerator<SubscribeFrame> {
    // The snapshot is as the tree stands when the subscription opens, and what is published after
    // that is kept for it, so an entry told before the client reads its first frame is not lost
    // and never numbers below the snapshot's cursor.
    const snapshot = treeSnapshot({ n, nodes: [...mains, ...nodes] });
    const live = feed.follow();

    async function* read(): AsyncGenerator<SubscribeFrame> {
      yield snapshot;
      yield* live;
    }

    return read();
  }

  return {
    follow,
    /** The tree as it stands now, as `getTree` answers it. */
    snapshot: () => treeSnapshotSchema.parse(treeSnapshot({ n, nodes: [...mains, ...nodes] })),
    /** Tells subscribers a node opened. */
    opened: (node: object) => {
      n += 1;
      feed.publish(treeEntry({ n, type: 'node_opened', fields: { node } }));
    },
    /** Tells subscribers a node changed while it lives: it is as `node` says now. */
    updated: (node: object) => {
      n += 1;
      feed.publish(treeEntry({ n, type: 'node_updated', fields: { node } }));
    },
    /** Tells subscribers a queued line started as the next prompt, which became `messageId`. */
    promptStarted: (params: { text: string; messageId: string; queued?: string[] }) => {
      n += 1;
      feed.publish(
        treeEntry({
          n,
          type: 'prompt_started',
          fields: { text: params.text, messageId: params.messageId, queued: params.queued ?? [] },
        }),
      );
    },
    /** Tells subscribers a notice of the conversation: an entry of `type` holding `fields`. */
    notice: (params: { type: string; fields: object }) => {
      n += 1;
      feed.publish(treeEntry({ n, type: params.type, fields: params.fields }));
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

/** Test-only: waits until `check` holds, for frames a fake server sends a moment after they are told. */
export async function until(check: () => boolean): Promise<void> {
  for (let tries = 0; tries < 200 && !check(); tries += 1) {
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

/** Test-only: the main agent, the node with no parent, running. */
export const MAIN_AGENT = agentNode({ id: 'main', state: 'running' });

/**
 * Test-only: the handlers of a backend whose tree channel fails right after its snapshot, as it
 * does when the conversation is closed: nothing more will come.
 */
export const FAILED_TREE: FakeHandlers = {
  async *streamChannels() {
    yield treeSnapshot({ n: 1, nodes: [MAIN_AGENT] });
    yield endedAs({ name: 'tree', reason: 'failed' });
  },
};

/** Test-only: an agent with no parent that was lost (the backend restarted under it). */
export const lostAgent = (id: string) => ({
  kind: 'agent',
  id,
  title: id,
  state: 'lost',
  startedAt: 1,
  endedAt: 2,
});

/**
 * Test-only: a node under the main agent, or under `parent`: a command, a service or a sub-agent,
 * running unless `state` says how it ended, with `status` as what it says it is doing. An agent
 * that ended says how its last run did with `outcome` (`completed` unless given; it must be the
 * outcome of its state: a turn limit is a `failed` agent).
 */
export function childNode(params: {
  id: string;
  kind: 'command' | 'service' | 'agent';
  state?: 'running' | 'completed' | 'failed' | 'cancelled';
  outcome?: string;
  title?: string;
  parent?: string;
  status?: string;
  /** The id of the tool call that started it. */
  spawnedBy?: string;
}) {
  const {
    id,
    kind,
    state = 'running',
    outcome = 'completed',
    title = id,
    parent = 'main',
    status,
    spawnedBy,
  } = params;
  const common = {
    id,
    kind,
    parent,
    ...(status !== undefined && { status }),
    ...(spawnedBy !== undefined && { spawnedBy }),
    title,
    state,
    startedAt: 1,
    ...(state !== 'running' && { endedAt: 3 }),
  };

  if (kind === 'agent') {
    return { ...common, ...(state !== 'running' && { lastOutcome: outcome }) };
  }

  return { ...common, command: 'make', description: 'build', output: '' };
}

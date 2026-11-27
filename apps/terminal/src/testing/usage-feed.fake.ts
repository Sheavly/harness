import { endedAs, usageFigures } from '@sheavly/client/testing/frames.fake';
import type { SubscribeFrame } from '@sheavly/protocol/subscription/subscription.types';
import { subscribeFrameSchema } from '@sheavly/protocol/subscription/subscription.validator';
import type { ContextFill } from '@sheavly/protocol/usage/usage.types';
import { liveFeed } from './live-feed.fake.js';

/** Test-only: what a node has used, as a test says it: its calls, and how full its context is. */
type FedNodeUsage = { node: string; calls: number; context?: ContextFill };

/** Test-only: a node's record as the usage channel carries it (not yet parsed). */
const recordOf = ({ node, calls, context }: FedNodeUsage) => ({
  ...usageFigures(calls),
  node,
  ...(context && { context }),
});

/**
 * Test-only: a conversation's usage as a backend sends it to a subscriber of the usage channel: the
 * snapshot of the usage as it stands (`total` calls, and the `nodes` that have made one), then each
 * entry published after, in order. Its stream never ends of its own. A fake server's
 * `streamChannels` answers with `follow()`.
 */
export function usageFeed(
  initial: { total: number; nodes: FedNodeUsage[] } = { total: 0, nodes: [] },
) {
  const feed = liveFeed<SubscribeFrame>();
  const nodes = new Map(initial.nodes.map((record) => [record.node, record]));
  let total = initial.total;
  let n = 1;

  function follow(): AsyncGenerator<SubscribeFrame> {
    // The snapshot is the usage as it stands when the subscription opens, and what is published
    // after that is kept for it, so an entry told before the first read is not lost.
    const snapshot = subscribeFrameSchema.parse({
      channel: 'usage',
      cursor: `s${String(n)}`,
      at: n,
      type: 'snapshot',
      total: usageFigures(total),
      nodes: [...nodes.values()].map(recordOf),
    });
    const live = feed.follow();

    async function* read(): AsyncGenerator<SubscribeFrame> {
      yield snapshot;
      yield* live;
    }

    return read();
  }

  return {
    follow,
    /** Tells subscribers a node's usage changed: it is `record` now, and the total `total` calls. */
    entry: (params: { record: FedNodeUsage; total: number }) => {
      n += 1;
      total = params.total;
      nodes.set(params.record.node, params.record);
      feed.publish(
        subscribeFrameSchema.parse({
          channel: 'usage',
          cursor: `s${String(n)}`,
          at: n,
          type: 'node_usage',
          usage: recordOf(params.record),
          total: usageFigures(params.total),
        }),
      );
    },
    /** Tells subscribers the usage channel failed, as it does when its conversation closes. */
    failed: () => feed.publish(endedAs({ name: 'usage', reason: 'failed' })),
  };
}

import {
  agentClosed,
  agentEvent,
  agentEventOmitted,
  agentRunStarted,
  agentUpdated,
  endedAs,
  headAt,
} from '@sheavly/client/testing/frames.fake';
import type { FakeCall, FakeRefusal } from '@sheavly/client/testing/testing.types';
import { TREE_CHANNEL_NAME } from '@sheavly/protocol/node/node.constants';
import type { SubscribeFrame } from '@sheavly/protocol/subscription/subscription.types';
import { subscribeRequestSchema } from '@sheavly/protocol/subscription/subscription.validator';
import { liveFeed } from './live-feed.fake.js';
import type { treeFeed } from './tree-feed.fake.js';

/**
 * Test-only: an agent's channel as a backend sends it to a subscriber: from `now`, where the
 * channel stands (`head`) and then each entry published after, in order; from `start` or a cursor,
 * the entries kept after it first. Its entries are numbered from 1, as the channel's cursor is.
 */
export function nodeFeed(name: string) {
  const live = liveFeed<SubscribeFrame>();
  const kept: { n: number; frame: SubscribeFrame }[] = [];
  let n = 0;

  /** Stores the next entry, made as entry number `n`, and sends it to the subscribers. */
  const publish = (make: (number: number) => SubscribeFrame) => {
    n += 1;

    const frame = make(n);

    kept.push({ n, frame });
    live.publish(frame);
  };

  function follow(from: string): AsyncGenerator<SubscribeFrame> {
    // Subscribed now, so what is published before the first read is kept, as the connection's is.
    const after = live.follow();
    const resumedAfter = /^s(\d+)$/.exec(from)?.[1];
    const first =
      from === 'now'
        ? [headAt({ name, cursor: `s${String(n)}` })]
        : kept
            .filter((entry) => resumedAfter === undefined || entry.n > Number(resumedAfter))
            .map(({ frame }) => frame);

    async function* read(): AsyncGenerator<SubscribeFrame> {
      yield* first;
      yield* after;
    }

    return read();
  }

  return {
    follow,
    /** Tells subscribers of a loop event of the agent (`lastSeq` when it merged text deltas). */
    event: (params: { event: object; messageId?: string; lastSeq?: number }) =>
      publish((number) => agentEvent({ name, n: number, ...params })),
    /** Tells subscribers of an event too large to store. */
    omitted: (params: { eventType: string; seq: number; size: number }) =>
      publish((number) => agentEventOmitted({ name, n: number, ...params })),
    /** Tells subscribers where a run starts. */
    runStarted: (params: { cause: 'prompt' | 'wake'; messageId: string; text?: string }) =>
      publish((number) => agentRunStarted({ name, n: number, ...params })),
    /** Tells subscribers the agent changed: it is as it was, running, with `status`. */
    updated: (status?: string) =>
      publish((number) => agentUpdated({ name, n: number, ...(status && { status }) })),
    /** Ends the channel as it does when the agent ends: its `closed` entry, then `completed`. */
    closed: () => {
      publish((number) => agentClosed({ name, n: number }));
      live.publish(endedAs({ name, reason: 'completed' }));
    },
    /** Ends the channel `failed`, as it does when storing it failed or its conversation closed. */
    failed: () => live.publish(endedAs({ name, reason: 'failed' })),
  };
}

/** Test-only: the agents' channels a fake backend has, each made the first time it is asked for. */
export function nodeFeeds() {
  const feeds = new Map<string, ReturnType<typeof nodeFeed>>();

  return {
    /** The channel of agent `name`, which a backend then has. */
    of: (name: string) => {
      const feed = feeds.get(name) ?? nodeFeed(name);

      feeds.set(name, feed);

      return feed;
    },
    /** The channel of agent `name` when a backend has one. */
    find: (name: string) => feeds.get(name),
  };
}

/**
 * Test-only: what a fake backend's `streamChannels` answers a subscription: the tree channel's
 * frames, or the frames of the agent's channel it names from where it asks (`from`), or `not_found`
 * for a node the backend has no channel for.
 */
export function routeChannels(params: {
  call: FakeCall;
  tree: ReturnType<typeof treeFeed>;
  nodes: ReturnType<typeof nodeFeeds>;
}): AsyncGenerator<SubscribeFrame> | FakeRefusal {
  const { call, tree, nodes } = params;
  const [subscription] = subscribeRequestSchema.parse(call.body).subscriptions;

  if (!subscription || subscription.channel === TREE_CHANNEL_NAME) return tree.follow();

  const feed = nodes.find(subscription.channel);

  return feed ? feed.follow(subscription.from) : { refuse: { status: 404, code: 'not_found' } };
}

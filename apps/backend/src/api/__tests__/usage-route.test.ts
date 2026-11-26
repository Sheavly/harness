import { describe, expect, it } from 'vitest';
import {
  usageChannelEntrySchema,
  usageSnapshotSchema,
} from '@sheavly/protocol/usage/usage-channel.validator';
import { applyUsageEntry, emptyUsage } from '@sheavly/protocol/usage/usage.utils';
import { readChannel } from '@sheavly/runtime/testing/stored-channels.fake';
import type { Script } from '@sheavly/testing/provider/provider.types';
import { useOpenedServers } from '../../testing/opened-servers.fake.js';
import { describeChannelRouteRefusals } from '../../testing/route-refusals.fake.js';
import { servedConversation } from '../../testing/served-conversation.fake.js';
import { framesOf } from '../../testing/subscription-frames.fake.js';

// What a conversation has used over HTTP: the snapshot a client starts from, the usage channel
// followed through the subscribe route from that snapshot, and what the route refuses.

const servers = useOpenedServers();

/** A model turn that says `text` and reports what it used, with the cost its model's rate makes of it. */
const reports =
  (text: string): Script =>
  () => [
    { type: 'text_delta', text },
    {
      type: 'done',
      stopReason: 'end_turn',
      usage: {
        tokens: {
          inputTokens: 1_000,
          outputTokens: 200,
          cacheReadTokens: 600,
          cacheWriteTokens: 100,
        },
        estimatedCostUsd: 0.01,
      },
    },
  ];

type Served = Awaited<ReturnType<typeof servedConversation>>;

/** The usage the stored channel builds, folded entry by entry: what a client that replayed has. */
async function replayed(world: Served) {
  const entries = await readChannel({
    store: world.store,
    id: world.conversation,
    channel: 'usage',
  });

  return entries.reduce(
    (usage, entry) => applyUsageEntry({ usage, entry: usageChannelEntrySchema.parse(entry) }),
    emptyUsage(),
  );
}

describe('what a conversation has used, over HTTP', () => {
  it('shows a client what the model calls used, per node and in total, with the cache and the cost, as the contract says and as a replay does', async () => {
    const world = await servedConversation({ servers, replies: [reports('one')] });

    // Through the generated client, which parses the answer with the route's own schema.
    const snapshot = await world.client.call('getUsage', { id: world.id });

    expect(usageSnapshotSchema.safeParse(snapshot).success).toBe(true);
    expect(snapshot.total).toMatchObject({
      calls: 1,
      inputTokens: 1_000,
      outputTokens: 200,
      cacheReadTokens: 600,
      cacheWriteTokens: 100,
      estimatedCostUsd: 0.01,
      incomplete: false,
    });
    expect(snapshot.nodes).toHaveLength(1);
    expect(snapshot.nodes[0]).toMatchObject({ calls: 1, context: { used: 1_200, cached: 600 } });
    expect(await replayed(world)).toEqual({ total: snapshot.total, nodes: snapshot.nodes });
  });

  it('counts a call that reported no tokens as missing, never as zero usage', async () => {
    const world = await servedConversation({ servers });
    const snapshot = await world.client.call('getUsage', { id: world.id });

    expect(snapshot.total).toMatchObject({ calls: 1, inputTokens: 0, missingUsageCalls: 1 });
  });

  it('is followed through the subscribe route from the snapshot, as server-sent frames, to the same usage', async () => {
    const world = await servedConversation({ servers, replies: [reports('one'), reports('two')] });
    const next = framesOf(
      await world.client.open('streamChannels', {
        id: world.id,
        body: { subscriptions: [{ channel: 'usage', from: 'snapshot' }] },
      }),
    );
    const first = await next();

    for await (const _frame of world.api.runOf({ id: world.id, text: 'go' }));

    const entry = await next();

    // The usage as it stood travels as `snapshot`, what comes after it as `entry`.
    expect(first).toMatchObject({
      event: 'snapshot',
      frame: { type: 'snapshot', channel: 'usage' },
    });
    expect(entry).toMatchObject({ event: 'entry', frame: { type: 'node_usage', cursor: 's2' } });

    const start = usageSnapshotSchema.parse(first?.frame);
    const followed = applyUsageEntry({
      usage: { total: start.total, nodes: start.nodes },
      entry: usageChannelEntrySchema.parse(entry?.frame),
    });
    const now = await world.client.call('getUsage', { id: world.id });

    expect(start.total.calls).toBe(1);
    expect(followed).toEqual({ total: now.total, nodes: now.nodes });
    expect(now.total.calls).toBe(2);
  });
});

describeChannelRouteRefusals({ route: 'usage', channel: 'usage', servers });

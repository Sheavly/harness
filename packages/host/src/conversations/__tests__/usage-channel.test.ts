import { describe, expect, it } from 'vitest';
import type { StreamEvent } from '@sheavly/core/message/message.types';
import {
  usageChannelEntrySchema,
  usageSnapshotSchema,
} from '@sheavly/protocol/usage/usage-channel.validator';
import { applyUsageEntry, emptyUsage } from '@sheavly/protocol/usage/usage.utils';
import { readChannel, shapeOf } from '@sheavly/runtime/testing/stored-channels.fake';
import { collect } from '@sheavly/testing/fetch/fake-fetch.fake';
import { MemoryConversationStore } from '@sheavly/testing/store/memory-store.fake';
import { ConversationsError } from '../../errors/conversations.errors.js';
import { say, scriptedConversations } from '../../testing/conversations.fake.js';
import { refusalOf, requestOf, take } from '../../testing/subscription-world.fake.js';
import type { Conversations } from '../conversations.service.js';

const TOKENS = {
  inputTokens: 1_000,
  outputTokens: 200,
  cacheReadTokens: 600,
  cacheWriteTokens: 100,
};

/** A model turn that says `text` and reports what it used, with the cost its model's rate makes of it. */
const reports = (text: string, cost = 0.01): StreamEvent[] => [
  { type: 'text_delta', text },
  {
    type: 'done',
    stopReason: 'end_turn',
    usage: { tokens: TOKENS, estimatedCostUsd: cost },
  },
];

/** A kept conversation that ran `prompts` prompts, each a model turn that reports its usage. */
async function ran(prompts: number) {
  const store = new MemoryConversationStore();
  const { conversations } = scriptedConversations({
    store,
    replies: ['one', 'two', 'three', 'four'].map((text) => reports(text)),
  });
  const id = await conversations.start();

  for (let turn = 0; turn < prompts; turn += 1) await prompt({ conversations, id, text: 'go' });

  return { store, id, conversations, harness: conversations.get(id).harness };
}

type KeptRun = Awaited<ReturnType<typeof ran>>;

/** Sends a prompt and waits for its run to end and what it told the channels to be stored. */
async function prompt(params: { conversations: Conversations; id: KeptRun['id']; text: string }) {
  await collect(
    (await params.conversations.send({ id: params.id, prompt: { text: params.text } })).events,
  );
  await params.conversations.get(params.id).harness.usageChannel?.flush();
}

/** Every entry of the stored usage channel, as the contract reads it. */
async function storedUsage(world: Pick<KeptRun, 'store' | 'id'>) {
  const entries = await readChannel({ store: world.store, id: world.id, channel: 'usage' });

  return entries.map((entry) => usageChannelEntrySchema.parse(entry));
}

describe('what a kept conversation has used', () => {
  it('is its total and each node’s, with the tokens the cache served and the cost, as the contract says', async () => {
    const world = await ran(2);
    const snapshot = await world.conversations.usage(world.id);
    const main = world.harness.sessions.nodeIdOf(world.harness.mainSession.id);

    expect(usageSnapshotSchema.safeParse(snapshot).success).toBe(true);
    expect(snapshot.total).toMatchObject({
      calls: 2,
      inputTokens: 2_000,
      outputTokens: 400,
      cacheReadTokens: 1_200,
      cacheWriteTokens: 200,
      incomplete: false,
    });
    expect(snapshot.total.estimatedCostUsd).toBeCloseTo(0.02, 10);
    expect(snapshot.nodes).toHaveLength(1);
    // The loop sets a call's window from its provider's, and this provider states none.
    expect(snapshot.nodes[0]).toMatchObject({ node: main, calls: 2 });
    expect(snapshot.nodes[0]?.context).toEqual({ used: 1_200, cached: 600 });
  });

  it('is the same for a client that starts from the snapshot as for one that replayed the stored channel', async () => {
    const world = await ran(2);
    const snapshot = await world.conversations.usage(world.id);
    const replayed = (await storedUsage(world)).reduce(
      (usage, entry) => applyUsageEntry({ usage, entry }),
      emptyUsage(),
    );

    expect({ total: snapshot.total, nodes: snapshot.nodes }).toEqual(replayed);
    expect(
      shapeOf(await readChannel({ store: world.store, id: world.id, channel: 'usage' })),
    ).toEqual(['opened s0', 'node_usage s1', 'node_usage s2']);
  });

  it('is told live: a client that starts from a snapshot and follows after its cursor misses nothing and counts nothing twice', async () => {
    const world = await ran(1);
    const subscription = await world.conversations.subscribe({
      id: world.id,
      request: requestOf('usage', 'snapshot'),
    });
    const frames = subscription.frames();
    const [first] = await take(frames, 1);
    const start = usageSnapshotSchema.parse(first);

    await prompt({ conversations: world.conversations, id: world.id, text: 'again' });

    const [entry] = await take(frames, 1);

    subscription.close();

    const next = usageChannelEntrySchema.parse(entry);
    const followed = applyUsageEntry({
      usage: { total: start.total, nodes: start.nodes },
      entry: next,
    });
    const now = await world.conversations.usage(world.id);

    expect(start).toMatchObject({ channel: 'usage', cursor: 's1', total: { calls: 1 } });
    expect(next).toMatchObject({ type: 'node_usage', cursor: 's2' });
    expect(followed).toEqual({ total: now.total, nodes: now.nodes });
    expect(now.total.calls).toBe(2);
  });

  it('is served from the start of the channel too, as any channel is', async () => {
    const world = await ran(1);
    const subscription = await world.conversations.subscribe({
      id: world.id,
      request: requestOf('usage', 'start'),
    });
    const heard = await take(subscription.frames(), 2);

    subscription.close();

    expect(heard.map((frame) => ('type' in frame ? frame.type : ''))).toEqual([
      'opened',
      'node_usage',
    ]);
  });

  it('goes on after a reopen: the first life’s nodes keep their records and the total still covers them', async () => {
    const world = await ran(2);
    const second = scriptedConversations({ store: world.store, replies: [reports('three')] });

    await second.conversations.reopen(world.id);

    const before = await second.conversations.usage(world.id);

    await prompt({ conversations: second.conversations, id: world.id, text: 'again' });

    const after = await second.conversations.usage(world.id);

    expect(before.total.calls).toBe(2);
    expect(before.nodes).toHaveLength(1);
    expect(after.total.calls).toBe(3);
    expect(after.nodes.map(({ calls }) => calls)).toEqual([2, 1]);
    expect(
      shapeOf(await readChannel({ store: world.store, id: world.id, channel: 'usage' })),
    ).toEqual(['opened s0', 'node_usage s1', 'node_usage s2', 'node_usage s3']);
  });

  it('is empty, and not an error, for a conversation that has made no call', async () => {
    const store = new MemoryConversationStore();
    const { conversations } = scriptedConversations({ store, replies: [say('one')] });
    const id = await conversations.start();
    const snapshot = await conversations.usage(id);

    expect(snapshot).toMatchObject({ total: { calls: 0 }, nodes: [] });
  });
});

describe('what a request for usage cannot have', () => {
  it('has none for a host that keeps nothing, or a conversation that is gone', async () => {
    const { conversations } = scriptedConversations({ replies: [say('one')] });
    const id = await conversations.start();
    const refusal = await refusalOf(conversations.usage(id));

    expect(refusal).toBeInstanceOf(ConversationsError);
    expect(refusal).toMatchObject({
      reason: 'not_found',
      message: 'This conversation keeps no usage: its host stores nothing',
    });

    const gone = await ran(1);

    await gone.conversations.close(gone.id);

    expect(await refusalOf(gone.conversations.usage(gone.id))).toMatchObject({
      reason: 'not_found',
    });
  });

  it('is told, for the usage channel of a conversation that keeps none, as for any channel it does not have', async () => {
    const { conversations } = scriptedConversations({ replies: [say('one')] });
    const id = await conversations.start();
    const refusal = await refusalOf(
      conversations.subscribe({ id, request: requestOf('usage', 'start') }),
    );

    expect(refusal).toMatchObject({ reason: 'not_found' });
  });

  it('is refused as a storage failure, saying why, when the stored channel could not be gone on from', async () => {
    const world = await ran(1);
    const stored = await storedUsage(world);

    await world.store.channel({ id: world.id, channel: 'usage' }).append({
      channel: 'usage',
      cursor: `s${String(stored.length)}`,
      at: 1,
      type: 'note',
    });

    const second = scriptedConversations({ store: world.store, replies: [reports('two')] });

    expect(await second.conversations.reopen(world.id)).toBe(world.id);
    expect(await refusalOf(second.conversations.usage(world.id))).toMatchObject({
      reason: 'storage_failed',
    });
  });
});

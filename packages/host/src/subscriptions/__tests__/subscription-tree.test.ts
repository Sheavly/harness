import { describe, expect, it } from 'vitest';
import { callIdSchema } from '@sheavly/protocol/message/message.validator';
import { treeSnapshotSchema } from '@sheavly/protocol/tree/tree.validator';
import { ConversationChannels } from '@sheavly/runtime/nodes/conversation-channels.service';
import { conversationId } from '@sheavly/runtime/testing/stored-conversation.fake';
import { treeConversation } from '@sheavly/runtime/testing/tree-conversation.fake';
import { HeldBytes } from '../held-bytes.service.js';
import { Subscription } from '../subscription.service.js';
import { tag, take } from '../../testing/subscription-world.fake.js';

const CALL = callIdSchema.parse('call_1');
const ROOMY = 1_000_000;

type World = ReturnType<typeof treeConversation>;

/** The conversation's channels as the host holds them: the tree writer, by its name. */
function conversationOf(tree: World['tree']) {
  const channels = new ConversationChannels();

  channels.add(tree);

  return channels;
}

/** Opens a subscription to the tree channel from `from`, with the tree writer unless `tree` is false. */
function openTree(params: {
  world: World;
  from: string;
  tree?: boolean;
  pool?: HeldBytes;
  budget?: number;
}) {
  const { world, from, tree = true } = params;

  return Subscription.open({
    writer: world.writer,
    ...(tree && { conversation: conversationOf(world.tree) }),
    channels: [
      {
        channel: 'tree',
        from,
        kind: 'sequence',
        log: world.store.channel({ id: conversationId, channel: 'tree' }),
      },
    ],
    budget: { left: params.budget ?? ROOMY },
    pool: params.pool ?? new HeldBytes(ROOMY),
    onClose: () => undefined,
  });
}

/** A sub-agent of the main agent. */
const spawn = (world: World) =>
  world.sessions.startChild({ parentId: world.main.id, startedByCall: CALL, title: 'Reader' });

describe('a subscription to the tree channel from a snapshot', () => {
  it('sends the tree first and then only what comes after its cursor, not what was told while it was taken', async () => {
    const world = treeConversation();

    // Told, and not yet stored: the opening, the main agent, and this sub-agent. The subscription
    // follows before the snapshot waits for them, so it hears each as it is stored, and the
    // snapshot already holds them all.
    spawn(world);

    const subscription = await openTree({ world, from: 'snapshot' });
    const frames = subscription.frames();
    const [snapshot] = await take(frames, 1);

    spawn(world);

    const after = await take(frames, 1);

    subscription.close();

    expect(snapshot).toMatchObject({ type: 'snapshot', cursor: 's2' });
    expect(treeSnapshotSchema.safeParse(snapshot).success).toBe(true);
    expect((snapshot as { nodes: unknown[] }).nodes).toHaveLength(2);
    // Not `node_opened s1` and `s2` again: the snapshot has them.
    expect(after.map(tag)).toEqual(['node_opened s3']);
  });

  it('is one frame that counts against what the conversation holds, so one that does not fit is refused', async () => {
    const world = treeConversation();
    const pool = new HeldBytes(10);

    await expect(openTree({ world, from: 'snapshot', pool })).rejects.toMatchObject({
      reason: 'too_many_subscriptions',
    });
    // Refused, it holds nothing: the whole pool is there for the next.
    expect(pool.take(10)).toBe(true);
  });

  it('is memory the writer holds, not stored history, so the request’s history budget does not bound it', async () => {
    const world = treeConversation();
    const subscription = await openTree({ world, from: 'snapshot', budget: 1 });
    const [snapshot] = await take(subscription.frames(), 1);

    subscription.close();

    expect(snapshot).toMatchObject({ type: 'snapshot' });
  });

  it('is not there for a conversation whose tree no writer has, and holds nothing', async () => {
    const world = treeConversation();
    const pool = new HeldBytes(ROOMY);

    await world.tree.flush();
    await expect(openTree({ world, from: 'snapshot', tree: false, pool })).rejects.toMatchObject({
      reason: 'not_found',
    });
    expect(pool.take(ROOMY)).toBe(true);
  });
});

describe('a subscription to the tree channel from elsewhere', () => {
  it('reads the stored entries as the tree channel’s, from the start and as a tail', async () => {
    const world = treeConversation();

    spawn(world);
    await world.tree.flush();

    const all = await openTree({ world, from: 'start' });
    const tail = await openTree({ world, from: 'tail:2' });

    expect((await take(all.frames(), 3)).map(tag)).toEqual([
      'opened s0',
      'node_opened s1',
      'node_opened s2',
    ]);
    expect((await take(tail.frames(), 2)).map(tag)).toEqual(['node_opened s1', 'node_opened s2']);

    all.close();
    tail.close();
  });

  it('follows what the tree writer stores after, and ends as failed when the writer stops', async () => {
    const world = treeConversation();

    await world.tree.flush();

    const subscription = await openTree({ world, from: 'now' });
    const frames = subscription.frames();
    const [head] = await take(frames, 1);

    spawn(world);
    await world.tree.stop();

    const rest = await take(frames, 2);

    expect(head).toEqual({ type: 'head', channel: 'tree', cursor: 's1' });
    // The entry, then that nothing more will come, with the cursor to ask again after.
    expect(rest.map(tag)).toEqual(['node_opened s2', 'end:failed']);
    expect(rest.at(-1)).toMatchObject({ cursor: 's2' });
  });
});

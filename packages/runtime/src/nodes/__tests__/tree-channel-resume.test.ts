import { describe, expect, it } from 'vitest';
import { StoreError } from '@sheavly/core/errors/store.errors';
import { callIdSchema } from '@sheavly/protocol/message/message.validator';
import { treeChannelEntrySchema, treeSnapshotSchema } from '@sheavly/protocol/tree/tree.validator';
import { applyTreeEntry, emptyTree } from '@sheavly/protocol/tree/tree.utils';
import { useFixedClock } from '@sheavly/testing/clock/fixed-clock.fake';
import { MemoryConversationStore } from '@sheavly/testing/store/memory-store.fake';
import { startControlledTask } from '../../testing/controlled-task.fake.js';
import { shapeOf } from '../../testing/stored-channels.fake.js';
import { conversationId } from '../../testing/stored-conversation.fake.js';
import {
  reopenedTreeConversation,
  treeConversation,
  treeEntriesOf,
} from '../../testing/tree-conversation.fake.js';
import { TreeChannelWriter } from '../tree-channel-writer.service.js';

const CALL = callIdSchema.parse('call_1');

useFixedClock();

type World = ReturnType<typeof treeConversation>;

/** A conversation as a process that then died left it: a sub-agent, a service and a waiting approval. */
async function crashedConversation() {
  const world = treeConversation();
  const child = world.sessions.startChild({
    parentId: world.main.id,
    startedByCall: CALL,
    title: 'Reader',
  });

  startControlledTask({
    tasks: world.tasks,
    sessionId: world.main.id,
    callId: CALL,
    backgroundKind: 'service',
    command: 'npm run dev',
  });
  // Never answered: the process ended with it waiting.
  void world.approvals.request({
    callId: CALL,
    sessionId: child.id,
    tool: 'run_command',
    command: 'git push',
    concerns: [],
    signal: new AbortController().signal,
  });
  await world.tree.flush();

  return world;
}

/** The tree the whole stored channel builds: what a client that replayed it from the start has. */
async function replayed(world: Pick<World, 'store' | 'tree'>) {
  return (await treeEntriesOf(world)).reduce(
    (tree, entry) => applyTreeEntry({ tree, entry: treeChannelEntrySchema.parse(entry) }),
    emptyTree(),
  );
}

describe('the tree channel of a reopened conversation', () => {
  it('goes on from the stored channel: no second opening, the stopped process’s nodes lost and its approval given up', async () => {
    const before = await crashedConversation();
    const stored = shapeOf(await treeEntriesOf(before));
    const after = await reopenedTreeConversation(before.store);
    const entries = await treeEntriesOf(after);

    expect(stored).toEqual([
      'opened s0',
      'node_opened s1',
      'node_opened s2',
      'node_opened s3',
      'approval_requested s4',
    ]);
    // What was stored stays, numbered on: the three nodes still open are lost, the approval that
    // nobody can answer is given up, and this process's own main agent opens.
    expect(shapeOf(entries)).toEqual([
      ...stored,
      'node_closed s5',
      'node_closed s6',
      'node_closed s7',
      'approval_cancelled s8',
      'node_opened s9',
    ]);
    expect(entries.slice(5, 8).map((each) => (each.node as { state: string }).state)).toEqual([
      'lost',
      'lost',
      'lost',
    ]);
    // The approval was the sub-agent's, which is the second node the stopped process opened.
    expect(entries[8]).toMatchObject({ node: (entries[2]?.node as { id: string }).id });
    expect(entries[9]).toMatchObject({
      node: { id: after.nodeOf(after.main.id), state: 'running' },
    });
    expect(entries.every((each) => treeChannelEntrySchema.safeParse(each).success)).toBe(true);
  });

  it('has, as its snapshot, the lost nodes and this process’s main agent, and the same tree as a replay', async () => {
    const before = await crashedConversation();
    const after = await reopenedTreeConversation(before.store);
    const snapshot = await after.tree.snapshot();
    const tree = await replayed(after);

    expect(snapshot.cursor).toBe('s9');
    expect({ nodes: snapshot.nodes, approvals: snapshot.approvals }).toEqual(tree);
    expect(snapshot.approvals).toEqual([]);
    expect(snapshot.nodes.map(({ state }) => state)).toEqual(['lost', 'lost', 'lost', 'running']);
    expect(treeSnapshotSchema.safeParse(snapshot).success).toBe(true);
  });

  it('does not close as lost a node that ended, when the conversation was stopped and not lost', async () => {
    const before = treeConversation();

    before.sessions.end({ id: before.main.id, state: 'completed' });
    await before.tree.stop();

    const after = await reopenedTreeConversation(before.store);

    expect(shapeOf(await treeEntriesOf(after))).toEqual([
      'opened s0',
      'node_opened s1',
      'node_closed s2',
      // Nothing was left open: only this process's own main agent opens.
      'node_opened s3',
    ]);
  });

  it('opens the channel for a conversation that has none stored yet', async () => {
    const world = await reopenedTreeConversation(new MemoryConversationStore());

    expect(shapeOf(await treeEntriesOf(world))).toEqual(['opened s0', 'node_opened s1']);
  });
});

describe('reading the stored tree channel', () => {
  it('is nothing for a conversation with no tree channel, and where it stands for one that has', async () => {
    const store = new MemoryConversationStore();

    expect(await TreeChannelWriter.readStored({ store, id: conversationId })).toBeUndefined();

    const world = treeConversation({ store });

    world.sessions.idle({ id: world.main.id, outcome: 'completed' });
    await world.tree.flush();

    const resumed = await TreeChannelWriter.readStored({ store, id: conversationId });

    expect(resumed).toMatchObject({ next: 3, last: { cursor: 's2' } });
    expect(
      resumed && 'tree' in resumed ? resumed.tree.nodes.map(({ state }) => state) : [],
    ).toEqual(['idle']);
  });

  it.each([
    ['an entry no client could read', { type: 'note' }],
    ['a channel that ends in closed, which takes no more', { type: 'closed' }],
  ])('is a failure for %s, so the conversation can still reopen', async (_name, more) => {
    const store = new MemoryConversationStore();
    const log = store.channel({ id: conversationId, channel: 'tree' });

    await log.append({ channel: 'tree', cursor: 's0', at: 1, type: 'opened' });
    await log.append({ channel: 'tree', cursor: 's1', at: 2, ...more });

    const resumed = await TreeChannelWriter.readStored({ store, id: conversationId });

    expect(resumed).toMatchObject({ failure: expect.any(StoreError) as unknown });
  });
});

describe('a reopened conversation whose stored tree channel cannot be gone on from', () => {
  it('writes nothing to it, tells the failure once, and has no snapshot', async () => {
    const failure = new StoreError({ reason: 'invalid', message: 'damaged' });
    const world = treeConversation({ resumed: { failure } });

    world.sessions.idle({ id: world.main.id, outcome: 'completed' });
    await world.tree.flush();

    expect(world.treeFailures).toEqual([failure]);
    expect(world.tree.writing()).toBe(false);
    expect(await treeEntriesOf(world)).toEqual([]);
    await expect(world.tree.snapshot()).rejects.toBe(failure);
  });
});

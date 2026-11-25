import { describe, expect, it } from 'vitest';
import type { OutputWriter } from '@sheavly/core/output/output.types';
import type { ChannelEntry } from '@sheavly/core/store/store.types';
import { MAX_CHANNEL_ENTRY_CHARS } from '@sheavly/protocol/channel/channel.constants';
import { channelBoundarySchema } from '@sheavly/protocol/channel/channel.validator';
import { callIdSchema } from '@sheavly/protocol/message/message.validator';
import { MAX_NODE_COMMAND_CHARS } from '@sheavly/protocol/node/node.constants';
import { nodeInfoSchema } from '@sheavly/protocol/node/node.validator';
import { outputRefSchema } from '@sheavly/protocol/output/output.validator';
import { useFixedClock } from '@sheavly/testing/clock/fixed-clock.fake';
import { MemoryConversationStore } from '@sheavly/testing/store/memory-store.fake';
import { TaskRegistry } from '../../tasks/tasks.service.js';
import { startControlledTask } from '../../testing/controlled-task.fake.js';
import { shapeOf } from '../../testing/stored-channels.fake.js';
import { conversation, conversationId, entriesOf } from '../../testing/stored-conversation.fake.js';
import { NodeChannelWriter } from '../node-channel-writer.service.js';
import { NodeRegistry } from '../node-registry.service.js';

const id = conversationId;
const CALL = callIdSchema.parse('call_1');
const ref = outputRefSchema.parse('77777777-7777-4777-8777-777777777777');

useFixedClock();

/** A capture that has taken `bytes` of output when it closes. */
function capture(bytes: number): OutputWriter {
  return {
    log: { ref, bytes: 0, status: 'capturing' },
    append: () => undefined,
    close: () => Promise.resolve({ ref, bytes, status: 'complete' }),
  };
}

type World = ReturnType<typeof conversation>;

/** Starts a sub-agent of the main session, as a tool call `CALL` does. */
function spawn(params: { world: World; title: string }) {
  return params.world.sessions.startChild({
    parentId: params.world.main.id,
    startedByCall: CALL,
    title: params.title,
  });
}

/** A conversation, and the name of its main agent's channel. */
const agentWorldOf = (world: World) => ({ world, channel: world.nodeOf(world.main.id) });

const agentWorld = () => agentWorldOf(conversation());

describe('an agent’s channel in the store', () => {
  it('is its whole life: opened, each change, and closed with the outcome', async () => {
    const { world, channel } = agentWorld();

    world.sessions.idle({ id: world.main.id, outcome: 'completed' });
    world.sessions.resume(world.main.id);
    world.sessions.end({ id: world.main.id, state: 'completed' });

    const entries = await entriesOf({ world, channel });

    expect(shapeOf(entries)).toEqual(['opened s0', 'updated s1', 'updated s2', 'closed s3']);
    expect(entries[0]).toMatchObject({ node: { kind: 'agent', state: 'running', title: 'Main' } });
    expect(entries[1]).toMatchObject({ node: { state: 'idle', lastOutcome: 'completed' } });
    expect(entries[3]).toMatchObject({ state: 'completed', outcome: 'completed' });
    expect(entries[3]).not.toHaveProperty('node');
  });

  it('holds only entries the protocol’s own schemas accept', async () => {
    const { world, channel } = agentWorld();

    world.sessions.idle({ id: world.main.id, outcome: 'completed' });
    world.sessions.end({ id: world.main.id, state: 'completed' });

    const [opened, updated, closed] = await entriesOf({ world, channel });

    expect(channelBoundarySchema.safeParse(opened).success).toBe(true);
    expect(channelBoundarySchema.safeParse(closed).success).toBe(true);
    expect(nodeInfoSchema.safeParse(updated?.node).success).toBe(true);
  });

  it('records a status report as an update', async () => {
    const { world, channel } = agentWorld();

    world.sessions.report({ id: world.main.id, status: 'reading the tests' });

    const entries = await entriesOf({ world, channel });

    expect(shapeOf(entries)).toEqual(['opened s0', 'updated s1']);
    expect(entries[1]).toMatchObject({ node: { status: 'reading the tests' } });
  });

  /** The entries of the channel of a sub-agent spawned now, which the schema must accept. */
  async function spawnedEntries(world: World) {
    const child = spawn({ world, title: 'Reader' });
    const entries = await entriesOf({ world, channel: world.nodeOf(child.id) });

    expect(shapeOf(entries)).toEqual(['opened s0']);
    expect(channelBoundarySchema.safeParse(entries[0]).success).toBe(true);

    return entries;
  }

  it('gives a sub-agent a channel of its own that says where its parent’s stood', async () => {
    const { world, channel: parent } = agentWorld();

    world.sessions.report({ id: world.main.id, status: 'about to start a sub-agent' });

    // The parent had opened (s0) and reported (s1) when the child was spawned.
    expect((await spawnedEntries(world))[0]).toMatchObject({
      spawnedAt: { channel: parent, cursor: 's1' },
    });
  });

  it('links a sub-agent to the newest entry its parent’s channel holds, not to one that failed to be stored', async () => {
    const store = new MemoryConversationStore();
    const { world, channel: parent } = agentWorldOf(conversation({ store }));

    // `opened s0` lands; then the parent's next change, `updated s1`, fails to be stored.
    await world.writer.flush();
    store.failWith(new Error('disk gone'));
    world.sessions.report({ id: world.main.id, status: 'about to start a sub-agent' });
    await world.writer.flush();
    store.failWith(undefined);

    // The parent's counter had moved on to s1, which the store never took: the link names s0.
    expect((await spawnedEntries(world))[0]).toMatchObject({
      spawnedAt: { channel: parent, cursor: 's0' },
    });
  });

  it('does not store a sub-agent whose parent’s channel holds nothing to link it to', async () => {
    const store = new MemoryConversationStore();
    const world = conversation({ store });

    // The parent's `opened` itself fails to be stored.
    store.failWith(new Error('disk gone'));
    await world.writer.flush();
    store.failWith(undefined);

    const child = spawn({ world, title: 'Reader' });

    await world.writer.flush();

    expect(await store.channels(id)).toEqual([]);
    expect(world.nodeOf(child.id)).toBeDefined();
  });

  it('closes a sub-agent’s channel with its own outcome, and the parent’s is not touched', async () => {
    const world = conversation();
    const child = spawn({ world, title: 'Reader' });

    world.sessions.end({ id: child.id, state: 'failed' });

    const entries = await entriesOf({ world, channel: world.nodeOf(child.id) });

    expect(entries.at(-1)).toMatchObject({ type: 'closed', state: 'failed', outcome: 'failed' });
    expect(shapeOf(await entriesOf({ world, channel: world.nodeOf(world.main.id) }))).toEqual([
      'opened s0',
    ]);
  });

  /**
   * A registry holding a conversation as a reopened one does: a main agent that was idle, a
   * sub-agent it started that was running when the server stopped (restored, then lost), and one
   * that had finished. The writer is attached afterwards, as `createHarness` does.
   */
  function reopened() {
    const store = new MemoryConversationStore();
    const nodes = new NodeRegistry();
    const main = nodes.restore({
      kind: 'agent',
      title: 'Chat',
      state: 'idle',
      lastOutcome: 'completed',
      startedAt: 5,
    });
    const cut = nodes.restore({
      kind: 'agent',
      title: 'Cut off',
      parent: main.id,
      spawnedBy: CALL,
      state: 'running',
      startedAt: 6,
    });
    const done = nodes.restore({
      kind: 'agent',
      title: 'Done',
      parent: main.id,
      spawnedBy: CALL,
      state: 'completed',
      lastOutcome: 'completed',
      startedAt: 1,
      endedAt: 2,
    });

    nodes.lose(cut.id);

    const tasks = new TaskRegistry({ nodes, nodeIdOf: () => undefined });
    const writer = NodeChannelWriter.attach({
      nodes,
      tasks,
      storage: { log: (channel) => store.channel({ id, channel }) },
    });

    return { store, writer, nodes, main, cut, done };
  }

  it('begins a channel for the node a reopened conversation goes on with, as it was', async () => {
    const world = reopened();
    const entries = await entriesOf({ world, channel: world.main.id });

    expect(shapeOf(entries)).toEqual(['opened s0']);
    expect(entries[0]).toMatchObject({ node: { state: 'idle', startedAt: 5 } });
  });

  it('writes nothing for a node restored as ended or lost: its channel is in the store already', async () => {
    const world = reopened();

    await world.writer.flush();

    // Only the main agent was open when the writer looked; the nodes that ended are not written
    // again, and a lost one is not given an `opened` entry just to close it.
    expect(await world.store.channels(id)).toEqual([world.main.id]);
  });

  it('goes on writing the restored agent’s changes after its first entry', async () => {
    const world = reopened();

    world.nodes.resume(world.main.id);
    world.nodes.idle({ id: world.main.id, outcome: 'completed' });

    const entries = await entriesOf({ world, channel: world.main.id });

    expect(shapeOf(entries)).toEqual(['opened s0', 'updated s1', 'updated s2']);
  });
});

describe('a command’s or a service’s channel in the store', () => {
  /** Starts work of `backgroundKind` that ends when `finish` is called. */
  function startWork(params: {
    world: World;
    backgroundKind: 'task' | 'service';
    command?: string;
    output?: OutputWriter | undefined;
  }) {
    return startControlledTask({
      tasks: params.world.tasks,
      sessionId: params.world.main.id,
      callId: CALL,
      backgroundKind: params.backgroundKind,
      command: params.command ?? 'npm test',
      description: 'run the tests',
      capture: params.output,
    });
  }

  const nodeOfTask = (world: World) =>
    world.tasks.nodes.list().find((node) => node.kind !== 'agent')?.id ?? '';

  /** A command that ran and ended with `exitCode`, and the entries of its channel. */
  async function endedCommand(params: { exitCode: number; output?: OutputWriter | undefined }) {
    const world = conversation();
    const { finish } = startWork({ world, backgroundKind: 'task', output: params.output });

    finish(params.exitCode);
    // The task settles a few ticks after `finish`.
    await new Promise<void>((resolve) => setTimeout(resolve, 0));

    return { world, entries: await entriesOf({ world, channel: nodeOfTask(world) }) };
  }

  it('opens at byte 0 with the command from the task, and closes with the exit code at the output’s size', async () => {
    const { world, entries } = await endedCommand({ exitCode: 2, output: capture(4096) });

    expect(shapeOf(entries)).toEqual(['opened b0', 'closed b4096']);
    expect(entries[0]).toMatchObject({
      node: {
        kind: 'command',
        command: 'npm test',
        description: 'run the tests',
        output: '',
        state: 'running',
        parent: world.nodeOf(world.main.id),
      },
      spawnedAt: { channel: world.nodeOf(world.main.id), cursor: 's0' },
    });
    expect(entries[1]).toMatchObject({ state: 'failed', exitCode: 2 });
    expect(channelBoundarySchema.safeParse(entries[0]).success).toBe(true);
    expect(channelBoundarySchema.safeParse(entries[1]).success).toBe(true);
  });

  it('stores a service the same way, closed as cancelled when it is stopped', async () => {
    const world = conversation();
    const { task } = startWork({ world, backgroundKind: 'service' });

    await world.tasks.cancel(task.id);
    await new Promise<void>((resolve) => setTimeout(resolve, 0));

    const entries = await entriesOf({ world, channel: nodeOfTask(world) });

    expect(entries[0]).toMatchObject({ node: { kind: 'service' } });
    expect(entries.at(-1)).toMatchObject({ type: 'closed', state: 'cancelled' });
  });

  it('closes at offset 0 when the command’s output was not captured', async () => {
    const { entries } = await endedCommand({ exitCode: 0 });

    expect(shapeOf(entries)).toEqual(['opened b0', 'closed b0']);
    expect(entries[1]).toMatchObject({ state: 'completed', exitCode: 0 });
  });

  it('shortens a command that is too long for a stored entry, and the entry is one the schema accepts', async () => {
    const world = conversation();
    const command = 'x'.repeat(MAX_NODE_COMMAND_CHARS);

    startWork({ world, backgroundKind: 'task', command });

    const [opened] = await entriesOf({ world, channel: nodeOfTask(world) });
    const stored = opened as ChannelEntry & { node: { command: string } };

    expect(JSON.stringify(opened).length).toBeLessThanOrEqual(MAX_CHANNEL_ENTRY_CHARS);
    expect(stored.node.command.length).toBeGreaterThan(0);
    expect(stored.node.command.length).toBeLessThan(MAX_NODE_COMMAND_CHARS);
    expect(command.startsWith(stored.node.command)).toBe(true);
    expect(channelBoundarySchema.safeParse(opened).success).toBe(true);
  });

  it('stores a command whose text needs escaping inside the entry limit', async () => {
    const world = conversation();
    // Each of these takes six characters as JSON.
    const command = '\u0001'.repeat(MAX_NODE_COMMAND_CHARS);

    startWork({ world, backgroundKind: 'task', command });

    const [opened] = await entriesOf({ world, channel: nodeOfTask(world) });

    expect(JSON.stringify(opened).length).toBeLessThanOrEqual(MAX_CHANNEL_ENTRY_CHARS);
  });

  it('stores no channel for the task of a sub-agent: its node is the agent’s, which has one', async () => {
    const world = conversation();
    const child = spawn({ world, title: 'Reader' });

    world.tasks.start({
      command: 'sub-agent: Reader',
      description: 'Reader',
      callId: CALL,
      sessionId: world.main.id,
      agentSessionId: child.id,
      backgroundKind: 'agent',
      run: () => Promise.resolve({ exitCode: 0 }),
    });
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    await world.writer.flush();

    expect((await world.store.channels(id)).toSorted()).toEqual(
      [world.nodeOf(world.main.id), world.nodeOf(child.id)].toSorted(),
    );
  });
});

describe('a channel the store refuses', () => {
  it('is told once, and the writer tries no more entries of it, leaving the run going', async () => {
    const store = new MemoryConversationStore();
    const attempts: string[] = [];
    const { world, channel } = { ...agentWorldOf(conversation({ store, attempts })) };

    // `opened` lands; then the disk fails for the next change.
    await world.writer.flush();
    store.failWith(new Error('disk gone'));
    world.sessions.idle({ id: world.main.id, outcome: 'completed' });
    await world.writer.flush();

    expect(world.failures).toHaveLength(1);
    expect(world.writer.failure).toBe(world.failures[0]);
    expect(world.failures[0]).toMatchObject({ name: 'StoreError', reason: 'failed' });

    // The disk mends, but the channel has an entry missing. The writer must not go on past the
    // gap: a counted channel would take a later entry and read as whole without one.
    store.failWith(undefined);
    world.sessions.resume(world.main.id);
    world.sessions.end({ id: world.main.id, state: 'completed' });
    await world.writer.flush();

    // The failed `updated` was tried, and nothing after it: not the next change, not the `closed`.
    expect(attempts).toEqual(['opened s0', 'updated s1']);
    expect(shapeOf(await entriesOf({ world, channel }))).toEqual(['opened s0']);
    // Told once, not again for the entries it did not try.
    expect(world.failures).toHaveLength(1);
  });

  it('does not stop another channel from being written', async () => {
    const store = new MemoryConversationStore({ limits: { conversationChannels: 1 } });
    const world = conversation({ store });
    const child = spawn({ world, title: 'Reader' });

    await world.writer.flush();

    // The sub-agent's channel is one too many: refused and told, while the main agent's goes on.
    expect(world.failures).toHaveLength(1);
    expect(world.failures[0]).toMatchObject({ reason: 'quota' });

    world.sessions.end({ id: world.main.id, state: 'completed' });

    const entries = await entriesOf({ world, channel: world.nodeOf(world.main.id) });

    expect(shapeOf(entries)).toEqual(['opened s0', 'closed s1']);
    expect(await store.channels(id)).toEqual([world.nodeOf(world.main.id)]);
    expect(child.id).toBeDefined();
  });
});

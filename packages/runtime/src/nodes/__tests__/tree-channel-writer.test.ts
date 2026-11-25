import { describe, expect, it } from 'vitest';
import { MAX_CHANNEL_ENTRY_CHARS } from '@sheavly/protocol/channel/channel.constants';
import { callIdSchema, messageIdSchema } from '@sheavly/protocol/message/message.validator';
import { MAX_NODE_COMMAND_CHARS } from '@sheavly/protocol/node/node.constants';
import { sessionIdSchema } from '@sheavly/protocol/session/session.validator';
import { treeChannelEntrySchema, treeSnapshotSchema } from '@sheavly/protocol/tree/tree.validator';
import { applyTreeEntry, emptyTree } from '@sheavly/protocol/tree/tree.utils';
import { useFixedClock } from '@sheavly/testing/clock/fixed-clock.fake';
import { MemoryConversationStore } from '@sheavly/testing/store/memory-store.fake';
import { startControlledTask } from '../../testing/controlled-task.fake.js';
import { shapeOf } from '../../testing/stored-channels.fake.js';
import { treeConversation, treeEntriesOf } from '../../testing/tree-conversation.fake.js';
import type { ChannelEvent } from '../nodes.types.js';

const CALL = callIdSchema.parse('call_1');
const MESSAGE_ID = messageIdSchema.parse('0f8fad5b-d9cb-469f-a165-70867728950e');

useFixedClock();

type World = ReturnType<typeof treeConversation>;

/** A sub-agent of the main agent, as a tool call `CALL` starts one. */
const spawn = (world: World) =>
  world.sessions.startChild({ parentId: world.main.id, startedByCall: CALL, title: 'Reader' });

/** Asks for approval on behalf of `sessionId` (the main agent's when none), and waits for the answer. */
function ask(params: {
  world: World;
  command?: string;
  sessionId?: ReturnType<typeof sessionIdSchema.parse> | undefined;
  signal?: AbortSignal;
}) {
  const { world, command = 'git push', sessionId, signal } = params;

  return world.approvals.request({
    callId: CALL,
    ...(sessionId && { sessionId }),
    tool: 'run_command',
    command,
    concerns: [],
    signal: signal ?? new AbortController().signal,
  });
}

/** The id of the approval that has waited longest. */
function pendingId(world: World) {
  const [first] = world.approvals.pending();

  if (!first) throw new Error('no approval is waiting');

  return first.id;
}

describe('the tree channel in the store', () => {
  it('opens with the channel and the main agent, numbered from 0', async () => {
    const world = treeConversation();
    const entries = await treeEntriesOf(world);

    expect(shapeOf(entries)).toEqual(['opened s0', 'node_opened s1']);
    expect(entries[1]).toMatchObject({
      node: { kind: 'agent', id: world.nodeOf(world.main.id), title: 'Main', state: 'running' },
    });
  });

  it('holds each agent’s life: opened, each change and closed, in the order they happened', async () => {
    const world = treeConversation();
    const child = spawn(world);

    world.sessions.end({ id: child.id, state: 'completed' });
    world.sessions.idle({ id: world.main.id, outcome: 'completed' });

    const entries = await treeEntriesOf(world);

    expect(shapeOf(entries)).toEqual([
      'opened s0',
      'node_opened s1',
      'node_opened s2',
      'node_closed s3',
      'node_updated s4',
    ]);
    expect(entries[2]).toMatchObject({
      node: { id: world.nodeOf(child.id), parent: world.nodeOf(world.main.id), title: 'Reader' },
    });
    expect(entries[3]).toMatchObject({ node: { state: 'completed' } });
    expect(entries[4]).toMatchObject({ node: { state: 'idle' } });
  });

  it('holds a command and a service: running when they start, closed with their exit code', async () => {
    const world = treeConversation();
    const work = startControlledTask({
      tasks: world.tasks,
      sessionId: world.main.id,
      callId: CALL,
      backgroundKind: 'task',
      command: 'npm test',
      description: 'run the tests',
    });

    work.finish(2);
    startControlledTask({
      tasks: world.tasks,
      sessionId: world.main.id,
      callId: CALL,
      backgroundKind: 'service',
      command: 'npm run dev',
      description: 'the dev server',
    });
    // The first task settles a few ticks after `finish`.
    await new Promise<void>((resolve) => setTimeout(resolve, 0));

    const entries = await treeEntriesOf(world);

    expect(shapeOf(entries)).toEqual([
      'opened s0',
      'node_opened s1',
      'node_opened s2',
      'node_opened s3',
      'node_closed s4',
    ]);
    expect(entries[2]).toMatchObject({
      node: { kind: 'command', command: 'npm test', output: '', state: 'running' },
    });
    expect(entries[3]).toMatchObject({ node: { kind: 'service', command: 'npm run dev' } });
    expect(entries[4]).toMatchObject({
      node: { kind: 'command', state: 'failed', exitCode: 2 },
    });
  });
});

describe('the approvals on the tree channel', () => {
  it('say which node asked, when it is answered, and when it is given up', async () => {
    const world = treeConversation();
    const child = spawn(world);
    const givenUp = new AbortController();
    const answered = ask({ world, sessionId: child.id });
    const stopped = ask({ world, signal: givenUp.signal });
    const asker = pendingId(world);

    world.approvals.respond({ id: asker, response: { decision: 'approve' } });
    givenUp.abort(new Error('stopped'));
    await answered;
    await expect(stopped).rejects.toThrow('stopped');

    const entries = (await treeEntriesOf(world)).slice(3);

    expect(shapeOf(entries)).toEqual([
      'approval_requested s3',
      'approval_requested s4',
      'approval_resolved s5',
      'approval_cancelled s6',
    ]);
    expect(entries[0]).toMatchObject({ node: world.nodeOf(child.id), request: { id: asker } });
    // The one that asked for no session is the main agent's.
    expect(entries[1]).toMatchObject({ node: world.nodeOf(world.main.id) });
    expect(entries[2]).toMatchObject({
      node: world.nodeOf(child.id),
      id: asker,
      response: { decision: 'approve' },
    });
    expect(entries[3]).toMatchObject({ node: world.nodeOf(world.main.id) });
  });

  it('are not on the tree when the session that asked has no node, and nothing else of theirs is lost', async () => {
    const world = treeConversation();
    const ghost = ask({ world, sessionId: sessionIdSchema.parse('ghost') });

    world.approvals.respond({ id: pendingId(world), response: { decision: 'approve' } });
    await ghost;

    expect(shapeOf(await treeEntriesOf(world))).toEqual(['opened s0', 'node_opened s1']);
  });
});

describe('the notices of the conversation', () => {
  it('are entries of the tree channel, cut to fit when they are larger than an entry', async () => {
    const world = treeConversation();
    const queued = Array.from({ length: 5 }, () => 'x'.repeat(19_000));

    world.tree.noteQueueChanged(['one', 'two']);
    world.tree.notePromptStarted({ text: 'go', messageId: MESSAGE_ID, queued: ['two'] });
    world.tree.notePromptRefused({ text: 'bad', error: 'unknown skill', queued: [] });
    world.tree.noteQueueChanged(queued);
    world.tree.noteStorageFailed('disk full');

    const entries = (await treeEntriesOf(world)).slice(2);

    expect(shapeOf(entries)).toEqual([
      'queue_changed s2',
      'prompt_started s3',
      'prompt_refused s4',
      'queue_changed s5',
      'storage_failed s6',
    ]);
    expect(entries[0]).toMatchObject({ queued: ['one', 'two'] });
    expect(entries[3]?.queued).toHaveLength(5);
    expect(JSON.stringify(entries[3]).length).toBeLessThanOrEqual(MAX_CHANNEL_ENTRY_CHARS);
    expect(entries.every((each) => treeChannelEntrySchema.safeParse(each).success)).toBe(true);
  });
});

/** The tree channel's entry for an approval of `command`, which is asked and then skipped. */
async function requestedEntry(command: string) {
  const world = treeConversation();
  const waiting = ask({ world, command });

  world.approvals.respond({ id: pendingId(world), response: { decision: 'skip' } });
  await waiting;

  const [requested] = (await treeEntriesOf(world)).filter(
    (each) => each.type === 'approval_requested',
  );

  return requested;
}

describe('an entry larger than a stored entry may be', () => {
  it('is an approval whose command is cut, and says so as its first concern, never silently', async () => {
    const command = `echo ${'a'.repeat(200_000)}`;
    const requested = await requestedEntry(command);
    const request = requested?.request as { command: string; concerns: { reason: string }[] };

    expect(JSON.stringify(requested).length).toBeLessThanOrEqual(MAX_CHANNEL_ENTRY_CHARS);
    expect(command.startsWith(request.command)).toBe(true);
    expect(request.command.length).toBeLessThan(command.length);
    expect(request.concerns.at(-1)?.reason).toContain(`of ${String(command.length)} characters`);
    expect(request.concerns.at(-1)?.reason).toContain('do not approve it from this text');
  });

  it('is an approval that fits whole, with no concern added', async () => {
    const requested = await requestedEntry('git push origin main');

    expect(requested?.request).toMatchObject({ command: 'git push origin main', concerns: [] });
  });

  it('is a command node whose command is cut, so the tree still takes it', async () => {
    const world = treeConversation();

    startControlledTask({
      tasks: world.tasks,
      sessionId: world.main.id,
      callId: CALL,
      backgroundKind: 'service',
      command: `run ${'b'.repeat(MAX_NODE_COMMAND_CHARS)}`,
    });

    const entries = await treeEntriesOf(world);

    expect(shapeOf(entries)).toEqual(['opened s0', 'node_opened s1', 'node_opened s2']);
    expect(JSON.stringify(entries[2]).length).toBeLessThanOrEqual(MAX_CHANNEL_ENTRY_CHARS);
    expect(world.treeFailures).toEqual([]);
  });
});

describe('a snapshot of the tree', () => {
  it('is the tree the stored entries build, at the cursor of the last: the same as a replay', async () => {
    const world = treeConversation();
    const child = spawn(world);
    const waiting = ask({ world, sessionId: child.id });

    startControlledTask({
      tasks: world.tasks,
      sessionId: world.main.id,
      callId: CALL,
      backgroundKind: 'service',
      command: 'npm run dev',
    });
    world.sessions.idle({ id: world.main.id, outcome: 'completed' });

    const snapshot = await world.tree.snapshot();
    const replayed = (await treeEntriesOf(world)).reduce(
      (tree, entry) => applyTreeEntry({ tree, entry: treeChannelEntrySchema.parse(entry) }),
      emptyTree(),
    );

    // The channel, the main agent, the sub-agent, its approval, the service, the main agent idle.
    expect(snapshot.cursor).toBe('s5');
    expect({ nodes: snapshot.nodes, approvals: snapshot.approvals }).toEqual(replayed);
    expect(treeSnapshotSchema.safeParse(snapshot).success).toBe(true);
    // What a client that connects late sees: a pending approval and a service that runs on.
    expect(snapshot.approvals.map(({ node }) => node)).toEqual([world.nodeOf(child.id)]);
    expect(snapshot.nodes.map(({ kind, state }) => `${kind} ${state}`)).toEqual([
      'agent idle',
      'agent running',
      'service running',
    ]);

    world.approvals.respond({ id: pendingId(world), response: { decision: 'approve' } });
    await waiting;
  });

  it('has an ended node and not an approval that was answered', async () => {
    const world = treeConversation();
    const child = spawn(world);
    const waiting = ask({ world, sessionId: child.id });

    world.approvals.respond({ id: pendingId(world), response: { decision: 'approve' } });
    await waiting;
    world.sessions.end({ id: child.id, state: 'completed' });

    const snapshot = await world.tree.snapshot();

    expect(snapshot.approvals).toEqual([]);
    expect(snapshot.nodes.map(({ id, state }) => `${id} ${state}`)).toContain(
      `${world.nodeOf(child.id)} completed`,
    );
    expect(treeSnapshotSchema.safeParse(snapshot).success).toBe(true);
  });

  it('waits for what was told to be stored, so it never stands before an entry it follows', async () => {
    const world = treeConversation();

    spawn(world);

    // Told, not yet awaited: the snapshot includes it all the same.
    const snapshot = await world.tree.snapshot();

    expect(snapshot.cursor).toBe('s2');
    expect(snapshot.nodes).toHaveLength(2);
  });
});

describe('a follower of the tree channel', () => {
  it('is told each entry the store takes, with its place in the log, and not what came before', async () => {
    const world = treeConversation();
    const heard: ChannelEvent[] = [];

    await world.tree.flush();

    const stop = world.tree.follow((event) => heard.push(event));
    const child = spawn(world);

    world.sessions.end({ id: child.id, state: 'completed' });
    await world.tree.flush();
    stop();
    world.sessions.idle({ id: world.main.id, outcome: 'completed' });
    await world.tree.flush();

    expect(
      heard.map((event) =>
        event.type === 'stored' ? `${event.entry.type} #${String(event.ordinal)}` : event.type,
      ),
    ).toEqual(['node_opened #2', 'node_closed #3']);
  });

  it('is told once that the channel failed, and the channel takes no more entries', async () => {
    const store = new MemoryConversationStore();
    const world = treeConversation({ store });
    const heard: ChannelEvent[] = [];

    await world.tree.flush();
    world.tree.follow((event) => heard.push(event));
    store.failWith(new Error('disk gone'));
    spawn(world);
    await world.tree.flush();
    store.failWith(undefined);
    world.sessions.idle({ id: world.main.id, outcome: 'completed' });

    expect(heard).toEqual([{ type: 'failed' }]);
    expect(world.treeFailures).toHaveLength(1);
    expect(world.tree.writing()).toBe(false);
    expect(shapeOf(await treeEntriesOf(world))).toEqual(['opened s0', 'node_opened s1']);
  });
});

describe('a tree channel that cannot be stored', () => {
  it('still gives the snapshot of what was stored before it failed', async () => {
    const store = new MemoryConversationStore();
    const world = treeConversation({ store });

    await world.tree.flush();
    store.failWith(new Error('disk gone'));
    spawn(world);

    const snapshot = await world.tree.snapshot();

    expect(snapshot.cursor).toBe('s1');
    expect(snapshot.nodes).toHaveLength(1);
  });

  it('has no snapshot when not even its first entry was stored, and says why', async () => {
    const store = new MemoryConversationStore();

    store.failWith(new Error('disk gone'));

    const world = treeConversation({ store });

    await expect(world.tree.snapshot()).rejects.toMatchObject({ reason: 'failed' });
    expect(world.treeFailures).toHaveLength(1);
  });
});

describe('stopping the tree channel', () => {
  it('writes what was told, takes no entry after it, and does not close the channel', async () => {
    const world = treeConversation();
    const heard: ChannelEvent[] = [];

    await world.tree.flush();
    world.tree.follow((event) => heard.push(event));
    spawn(world);
    await world.tree.stop();
    await world.tree.stop();
    spawn(world);

    const entries = await treeEntriesOf(world);

    // Not closed: a closed channel takes no more entries, and the conversation can be reopened.
    expect(shapeOf(entries)).toEqual(['opened s0', 'node_opened s1', 'node_opened s2']);
    expect(entries.map((each) => each.type)).not.toContain('closed');
    // Followers heard the entry, then, once, that nothing more will come.
    expect(heard.map((event) => event.type)).toEqual(['stored', 'failed']);
    expect(world.tree.writing()).toBe(false);
  });

  it('keeps writing until what was told is stored, so a reader joining then is not told it is over', async () => {
    const world = treeConversation();

    spawn(world);

    const stopping = world.tree.stop();

    expect(world.tree.writing()).toBe(true);

    await stopping;

    expect(world.tree.writing()).toBe(false);
  });

  it('still gives the snapshot of what it stored', async () => {
    const world = treeConversation();

    spawn(world);
    await world.tree.stop();

    const snapshot = await world.tree.snapshot();

    expect(snapshot.cursor).toBe('s2');
    expect(snapshot.nodes).toHaveLength(2);
  });
});

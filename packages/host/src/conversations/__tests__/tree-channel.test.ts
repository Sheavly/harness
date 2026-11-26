import { describe, expect, it } from 'vitest';
import { StoreError } from '@sheavly/core/errors/store.errors';
import { callIdSchema } from '@sheavly/protocol/message/message.validator';
import { treeChannelEntrySchema, treeSnapshotSchema } from '@sheavly/protocol/tree/tree.validator';
import { applyTreeEntry, emptyTree } from '@sheavly/protocol/tree/tree.utils';
import { readChannel, shapeOf } from '@sheavly/runtime/testing/stored-channels.fake';
import {
  answerWaitingApproval,
  askMainApproval,
  askUnheardApproval,
  startRunningService,
  treeFollowedFrom,
  treeSummaryOf,
} from '@sheavly/runtime/testing/tree-actions.fake';
import { MemoryConversationStore } from '@sheavly/testing/store/memory-store.fake';
import { ConversationsError } from '../../errors/conversations.errors.js';
import { say, scriptedConversations } from '../../testing/conversations.fake.js';
import { ranOnePrompt } from '../../testing/stored-conversation.fake.js';
import {
  claimingApprovals,
  refusalOf,
  requestOf,
  rest,
  take,
} from '../../testing/subscription-world.fake.js';
import { announceStorageFailure } from '../storage.helper.js';

const CALL = callIdSchema.parse('call_1');

/**
 * A memory store whose channel writes take a while, as a disk's do, so what a conversation told its
 * channels when it started is not stored yet when a client asks: a memory store is too quick to
 * show it.
 */
class SlowChannels extends MemoryConversationStore {
  override channel(params: Parameters<MemoryConversationStore['channel']>[0]) {
    const log = super.channel(params);

    return {
      head: () => log.head(),
      read: (from?: Parameters<typeof log.read>[0]) => log.read(from),
      append: async (entry: Parameters<typeof log.append>[0]) => {
        await new Promise<void>((resolve) => setTimeout(resolve, 20));
        await log.append(entry);
      },
    };
  }
}

/** A kept conversation that ran a prompt (its main agent is idle), and its harness. */
async function kept() {
  const store = new MemoryConversationStore();
  const { id, conversations } = await ranOnePrompt(store);

  return { store, id, conversations, harness: conversations.get(id).harness };
}

type Kept = Awaited<ReturnType<typeof kept>>;

/** Every entry of the stored tree channel, once what was told is written, as the contract reads it. */
async function storedTree(world: Pick<Kept, 'store' | 'id' | 'harness'>) {
  await world.harness.treeChannel?.flush();

  const entries = await readChannel({ store: world.store, id: world.id, channel: 'tree' });

  return entries.map((entry) => treeChannelEntrySchema.parse(entry));
}

/** The tree that folding every stored entry from the start gives: what a client that replayed has. */
const replayed = async (world: Pick<Kept, 'store' | 'id' | 'harness'>) =>
  (await storedTree(world)).reduce((tree, entry) => applyTreeEntry({ tree, entry }), emptyTree());

describe('the tree of a kept conversation', () => {
  it('shows a client that connects late the approval that waits and the service that runs on, as a replay does', async () => {
    const world = await kept();
    const waiting = askMainApproval(world.harness);

    startRunningService(world.harness);

    const snapshot = await world.conversations.tree(world.id);

    expect(treeSummaryOf(snapshot)).toEqual({
      nodes: ['agent idle', 'service running'],
      approvals: 1,
    });
    expect(treeSnapshotSchema.safeParse(snapshot).success).toBe(true);
    expect({ nodes: snapshot.nodes, approvals: snapshot.approvals }).toEqual(await replayed(world));

    answerWaitingApproval(world.harness);
    await waiting;
  });

  it('is the same for a client that starts from a snapshot and follows after its cursor as for one that replayed', async () => {
    const world = await kept();
    const subscription = await world.conversations.subscribe({
      id: world.id,
      request: requestOf('tree', 'snapshot'),
    });
    const frames = subscription.frames();
    const [snapshot] = await take(frames, 1);

    // After the snapshot: the main agent runs again, starts a sub-agent that lives and ends and a
    // service, and a tool of it asks for approval.
    world.harness.sessions.resume(world.harness.mainSession.id);

    const child = world.harness.sessions.startChild({
      parentId: world.harness.mainSession.id,
      startedByCall: CALL,
      title: 'Reader',
    });

    world.harness.sessions.end({ id: child.id, state: 'completed' });
    startRunningService(world.harness);

    const waiting = askMainApproval(world.harness);
    const after = await take(frames, 5);

    subscription.close();

    expect(snapshot).toMatchObject({ type: 'snapshot', channel: 'tree' });
    expect(after.map((frame) => ('type' in frame ? frame.type : ''))).toEqual([
      'node_updated',
      'node_opened',
      'node_closed',
      'node_opened',
      'approval_requested',
    ]);

    // The client: the snapshot, then each entry after it, folded the way every client folds.
    const start = treeSnapshotSchema.parse(snapshot);
    const followed = treeFollowedFrom({ snapshot, entries: after });

    expect(followed).toEqual(await replayed(world));
    // And nothing was sent twice: the cursors after the snapshot's are the next ones, in order.
    expect(after.map((frame) => ('cursor' in frame ? frame.cursor : ''))).toEqual(
      after.map((_frame, index) => `s${String(Number(start.cursor.slice(1)) + 1 + index)}`),
    );

    answerWaitingApproval(world.harness);
    await waiting;
  });

  it('serves the stored entries from the start, and where it stands at now, like any channel', async () => {
    const world = await kept();
    const stored = await storedTree(world);
    const history = await world.conversations.subscribe({
      id: world.id,
      request: requestOf('tree', 'start'),
    });
    const now = await world.conversations.subscribe({
      id: world.id,
      request: requestOf('tree', 'now'),
    });
    const head = await take(now.frames(), 1);

    expect(await take(history.frames(), stored.length)).toEqual(stored);
    expect(head).toEqual([{ type: 'head', channel: 'tree', cursor: stored.at(-1)?.cursor }]);

    history.close();
    now.close();
  });

  it('is there for a client that asks the moment the conversation starts, on a disk that takes a while', async () => {
    const store = new SlowChannels();
    const { conversations } = scriptedConversations({ store, replies: [say('one')] });
    const id = await conversations.start();
    const subscription = await conversations.subscribe({
      id,
      request: requestOf('tree', 'snapshot'),
    });
    const [snapshot] = await take(subscription.frames(), 1);

    expect(snapshot).toMatchObject({ type: 'snapshot', nodes: [{ kind: 'agent' }] });

    subscription.close();
  });
});

describe('the notices of a conversation on its tree channel', () => {
  it('has the queue, and a line that starts with the message it became', async () => {
    const store = new MemoryConversationStore();
    const { conversations } = scriptedConversations({ store, replies: [say('one'), say('two')] });
    const id = await conversations.start();
    const { harness } = conversations.get(id);

    await conversations.setQueue({ id, queued: ['a', 'b'] });
    await conversations.setQueue({ id, queued: [] });
    await conversations.submit({ id, prompt: { text: 'go' } });

    const entries = await storedTree({ store, id, harness });
    const noticeTypes = ['queue_changed', 'prompt_started', 'prompt_refused', 'storage_failed'];
    const notices = entries.filter(({ type }) => noticeTypes.includes(type));
    const started = notices.find(({ type }) => type === 'prompt_started');

    expect(notices.map(({ type }) => type).slice(0, 2)).toEqual(['queue_changed', 'queue_changed']);
    expect(notices[0]).toMatchObject({ queued: ['a', 'b'] });
    expect(started).toMatchObject({
      text: 'go',
      messageId: harness.sessions.messageOf(harness.mainSession.id),
    });
  });

  it('tells a storage failure, where a client that follows only the tree learns of it', async () => {
    const world = await kept();

    announceStorageFailure({
      live: world.conversations.get(world.id),
      failure: new StoreError({ reason: 'failed', message: 'disk gone' }),
    });

    const entries = await storedTree(world);

    expect(entries.at(-1)).toMatchObject({ type: 'storage_failed', error: 'disk gone' });
  });
});

describe('closing and reopening a conversation, for its tree', () => {
  it('ends what a follower hears when the conversation closes, and leaves the channel open to go on', async () => {
    const world = await kept();
    const subscription = await world.conversations.subscribe({
      id: world.id,
      request: requestOf('tree', 'now'),
    });

    await world.conversations.close(world.id);

    const heard = await rest(subscription.frames());
    const entries = await readChannel({ store: world.store, id: world.id, channel: 'tree' });

    expect(heard.at(-1)).toMatchObject({ type: 'end', channel: 'tree', reason: 'failed' });
    // The nodes the close ended are on the tree, and the channel is not closed: a reopen goes on.
    expect(entries.map(({ type }) => type)).toContain('node_closed');
    expect(entries.map(({ type }) => type)).not.toContain('closed');
  });

  it('goes on after a process that stopped without closing: its nodes lost, its approval given up, the new main agent there', async () => {
    const world = await kept();
    const waiting = askMainApproval(world.harness);

    startRunningService(world.harness);
    await world.harness.treeChannel?.flush();

    const before = shapeOf(
      await readChannel({ store: world.store, id: world.id, channel: 'tree' }),
    );
    // A new host on the same store: the first process is gone, and closed nothing.
    const second = scriptedConversations({ store: world.store, replies: [say('two')] });

    await second.conversations.reopen(world.id);

    const snapshot = await second.conversations.tree(world.id);
    const entries = await readChannel({ store: world.store, id: world.id, channel: 'tree' });

    expect(shapeOf(entries).slice(0, before.length)).toEqual(before);
    expect(snapshot.nodes.map(({ state }) => state)).toEqual(['lost', 'lost', 'idle']);
    expect(snapshot.approvals).toEqual([]);
    expect(entries.map(({ type }) => type)).not.toContain('closed');
    expect({ nodes: snapshot.nodes, approvals: snapshot.approvals }).toEqual(
      await replayed({
        store: world.store,
        id: world.id,
        harness: second.conversations.get(world.id).harness,
      }),
    );

    answerWaitingApproval(world.harness);
    await waiting;
  });

  it('reopens a conversation whose stored tree channel cannot be gone on from, and says why when its tree is asked for', async () => {
    const world = await kept();
    const stored = await storedTree(world);

    // An entry no client could read, numbered as the next one.
    await world.store.channel({ id: world.id, channel: 'tree' }).append({
      channel: 'tree',
      cursor: `s${String(stored.length)}`,
      at: 1,
      type: 'note',
    });

    const second = scriptedConversations({ store: world.store, replies: [say('two')] });

    expect(await second.conversations.reopen(world.id)).toBe(world.id);

    const refusal = await refusalOf(second.conversations.tree(world.id));

    expect(refusal).toBeInstanceOf(ConversationsError);
    expect(refusal).toMatchObject({ reason: 'storage_failed' });
    // Nothing was written to it, and the conversation itself runs.
    expect((await readChannel({ store: world.store, id: world.id, channel: 'tree' })).length).toBe(
      stored.length + 1,
    );
  });
});

describe('a connection that claims to answer approvals', () => {
  it('counts as someone listening for as long as it is open, and each connection on its own', async () => {
    const world = await kept();
    const { approvals } = world.harness;
    const open = () =>
      world.conversations.subscribe({ id: world.id, request: claimingApprovals() });

    expect(approvals.listening).toBe(false);

    const first = await open();
    const second = await open();

    expect(approvals.listening).toBe(true);
    first.close();
    // The other connection still answers.
    expect(approvals.listening).toBe(true);
    second.close();
    expect(approvals.listening).toBe(false);
  });

  it('makes an approval wait for an answer while it is open, and be refused at once once it is not', async () => {
    const world = await kept();
    const subscription = await world.conversations.subscribe({
      id: world.id,
      request: claimingApprovals(),
    });
    const waiting = askUnheardApproval(world.harness);

    expect(world.harness.approvals.pending()).toHaveLength(1);
    answerWaitingApproval(world.harness);
    await waiting;

    subscription.close();

    expect(await refusalOf(askUnheardApproval(world.harness))).toMatchObject({
      reason: 'no_listener',
    });
  });

  it('does not listen for a request that makes no claim, which only watches the tree', async () => {
    const world = await kept();
    const subscription = await world.conversations.subscribe({
      id: world.id,
      request: requestOf('tree', 'now'),
    });

    expect(world.harness.approvals.listening).toBe(false);
    expect(await refusalOf(askUnheardApproval(world.harness))).toMatchObject({
      reason: 'no_listener',
    });
    subscription.close();
  });

  it('stops listening when the request is refused, whatever it was refused for', async () => {
    const world = await kept();
    const refusal = await refusalOf(
      world.conversations.subscribe({
        id: world.id,
        request: claimingApprovals([['agent-9', 'start']]),
      }),
    );

    expect(refusal).toMatchObject({ reason: 'not_found' });
    expect(world.harness.approvals.listening).toBe(false);
  });
});

describe('what a request for the tree cannot have', () => {
  it('has no snapshot for a host that keeps nothing, or a conversation that is gone', async () => {
    const { conversations } = scriptedConversations({ replies: [say('one')] });
    const id = await conversations.start();

    expect(await refusalOf(conversations.tree(id))).toMatchObject({ reason: 'not_found' });

    const gone = await kept();

    await gone.conversations.close(gone.id);

    expect(await refusalOf(gone.conversations.tree(gone.id))).toMatchObject({
      reason: 'not_found',
    });
  });

  it('is told, for the tree of a conversation that keeps none, as for any channel it does not have', async () => {
    const { conversations } = scriptedConversations({ replies: [say('one')] });
    const id = await conversations.start();
    const refusal = await refusalOf(
      conversations.subscribe({ id, request: requestOf('tree', 'start') }),
    );

    expect(refusal).toMatchObject({ reason: 'not_found' });
  });
});

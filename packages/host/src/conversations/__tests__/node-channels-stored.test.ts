import { describe, expect, it, vi } from 'vitest';
import { StoreError } from '@sheavly/core/errors/store.errors';
import { readChannel, shapeOf } from '@sheavly/runtime/testing/stored-channels.fake';
import { MemoryConversationStore } from '@sheavly/testing/store/memory-store.fake';
import type { ConversationId } from '@sheavly/protocol/server/server.types';
import { say, scriptedConversations as setup } from '../../testing/conversations.fake.js';
import { ranOnePrompt } from '../../testing/stored-conversation.fake.js';
import type { Conversations } from '../conversations.service.js';
import { announceChannelFailures } from '../lifecycle.helper.js';

const entriesOf = async (params: {
  store: MemoryConversationStore;
  id: ConversationId;
  channel: string;
}) => readChannel(params);

/** The conversation's node channels: every stored channel but the tree's, which has its own tests. */
const nodeChannelsOf = async (params: { store: MemoryConversationStore; id: ConversationId }) =>
  (await params.store.channels(params.id)).filter((channel) => channel !== 'tree');

/** Lets every write of the conversation's node channels finish, as an app waits for its disk. */
async function written(conversations: Conversations, id: ConversationId) {
  await conversations.get(id).harness.nodeChannels?.flush();
}

type Log = ReturnType<MemoryConversationStore['channel']>;

/**
 * A memory store whose channel logs a test can change, to make a disk misbehave: `wrap` gets each
 * channel's real log and the channel's name, and returns the log the store hands out. The stream
 * and everything else are the memory store's own.
 */
class WrappedChannels extends MemoryConversationStore {
  wrap: (params: { channel: string; log: Log }) => Log = ({ log }) => log;

  override channel(params: Parameters<MemoryConversationStore['channel']>[0]) {
    return this.wrap({ channel: params.channel, log: super.channel(params) });
  }
}

/** A log that says what it holds and reads as `log` does, and appends as `append` says. */
const appendingAs = (log: Log, append: Log['append']): Log => ({
  head: () => log.head(),
  read: (from) => log.read(from),
  append,
});

/** A store whose channel writes all fail, as a full disk's would. */
const failingChannels = () => {
  const store = new WrappedChannels();

  store.wrap = ({ log }) =>
    appendingAs(log, async () => {
      throw new StoreError({ reason: 'failed', message: 'disk gone' });
    });

  return store;
};

/**
 * A store whose channel writes take a while, as a disk does, so a conversation being closed is
 * still writing its last entry when something else reads: a memory store is too quick to show it.
 */
const slowChannels = () => {
  const store = new WrappedChannels();

  store.wrap = ({ log }) =>
    appendingAs(log, async (entry) => {
      await new Promise<void>((resolve) => setTimeout(resolve, 20));
      await log.append(entry);
    });

  return store;
};

/** Makes the channels of `store` that `damaged` names unreadable, as a file with a damaged line is. */
function damageChannels(params: { store: WrappedChannels; damaged: (channel: string) => boolean }) {
  params.store.wrap = ({ channel, log }) =>
    params.damaged(channel)
      ? {
          append: async () => undefined,
          head: () =>
            Promise.reject(
              new StoreError({ reason: 'failed', message: 'Stored channel file is damaged' }),
            ),
          read: () => {
            throw new StoreError({ reason: 'failed', message: 'Stored channel file is damaged' });
          },
        }
      : log;
}

/** The `storage_failed` messages conversation `id` has put on its stream so far. */
async function announcedFailures(params: { conversations: Conversations; id: ConversationId }) {
  const heard: string[] = [];

  params.conversations.get(params.id).harness.sessions.subscribeEntries(
    (entry) => {
      if (entry.kind === 'event' && entry.event.type === 'storage_failed') {
        heard.push(entry.event.error);
      }
    },
    { replay: true },
  );
  await new Promise<void>((resolve) => setTimeout(resolve, 0));

  return heard;
}

/** A conversation that ran a prompt and whose process then ended, with nothing closed. */
async function stoppedConversation(store: MemoryConversationStore) {
  const first = await ranOnePrompt(store);

  await written(first.conversations, first.id);

  return { id: first.id, first };
}

describe('a conversation’s node channels in its store', () => {
  it('stores the main agent’s channel as the conversation runs', async () => {
    const store = new MemoryConversationStore();
    const { id } = await stoppedConversation(store);
    const [channel] = await nodeChannelsOf({ store, id });

    expect(await nodeChannelsOf({ store, id })).toHaveLength(1);

    const entries = await entriesOf({ store, id, channel: channel ?? '' });

    // The prompt ran (the agent was running, then idle again): each change is an entry, in order
    // and with no gap, and the channel is not closed while the conversation lives.
    expect(entries[0]).toMatchObject({ type: 'opened', cursor: 's0', node: { kind: 'agent' } });
    expect(entries.map((each) => each.cursor)).toEqual(
      entries.map((_each, index) => `s${String(index)}`),
    );
    expect(entries.at(-1)).toMatchObject({ type: 'updated', node: { state: 'idle' } });
    expect(entries.map((each) => each.type)).not.toContain('closed');
  });

  it('closes the channel of the agent when the conversation is closed', async () => {
    const store = new MemoryConversationStore();
    const { id, first } = await stoppedConversation(store);

    await first.conversations.close(id);

    const [channel] = await nodeChannelsOf({ store, id });
    const entries = await entriesOf({ store, id, channel: channel ?? '' });

    expect(entries.at(-1)).toMatchObject({ type: 'closed' });
    expect(entries.at(-1)).not.toMatchObject({ state: 'lost' });
  });

  it('waits for a conversation being closed before it reopens it: its channel closes, and is not lost', async () => {
    const store = slowChannels();
    const { id, first } = await stoppedConversation(store);
    const [channel] = await nodeChannelsOf({ store, id });

    // Not awaited in between: the reopen starts while the close is still writing.
    await Promise.all([first.conversations.close(id), first.conversations.reopen(id)]);

    const closes = (await entriesOf({ store, id, channel: channel ?? '' })).filter(
      (each) => each.type === 'closed',
    );

    expect(closes).toHaveLength(1);
    expect(closes[0]).not.toMatchObject({ state: 'lost' });
    // Reopened, with no failure announced for the close the reopen came too early for.
    expect(await announcedFailures({ conversations: first.conversations, id })).toEqual([]);
  });

  it('has written the channel’s end when a close whose release throws reports it', async () => {
    const store = slowChannels();
    const { id, first } = await stoppedConversation(store);
    const [channel] = await nodeChannelsOf({ store, id });
    const live = first.conversations.get(id);

    live.dispose = () => Promise.reject(new Error('cannot release'));
    await expect(first.conversations.close(id)).rejects.toThrow('cannot release');

    // A reopen waits for this close, so what the stopped conversation wrote must be there by now:
    // the channel's end, and the index saying the conversation is closed.
    const entries = await entriesOf({ store, id, channel: channel ?? '' });

    expect(entries.at(-1)).toMatchObject({ type: 'closed' });
    expect(await first.conversations.listStored()).toMatchObject([{ id, status: 'closed' }]);
  });

  it('reopens a conversation whose channel file is damaged, and says so once on its stream', async () => {
    const store = new WrappedChannels();
    const { id } = await stoppedConversation(store);
    const [damaged] = await nodeChannelsOf({ store, id });

    damageChannels({ store, damaged: (channel) => channel === damaged });

    const second = setup({ store, replies: [say('two')] });

    // The stream is intact, so the conversation reopens: a channel is not the record.
    expect(await second.conversations.reopen(id)).toBe(id);
    expect(await announcedFailures({ conversations: second.conversations, id })).toEqual([
      'A stored node channel could not be closed as lost, and reads as it was left (first: Stored channel file is damaged)',
    ]);
  });

  it('says so in one announcement however many channels are damaged', async () => {
    const store = new WrappedChannels();
    const { id } = await stoppedConversation(store);

    // A second stored node whose channel is damaged too: the stopped process had two.
    await store.channel({ id, channel: 'other-node' }).append({
      channel: 'other-node',
      type: 'opened',
      cursor: 's0',
      at: 1,
      node: { id: 'other-node', title: 'x' },
    });
    damageChannels({ store, damaged: (channel) => channel !== 'tree' });

    const second = setup({ store, replies: [say('two')] });

    await second.conversations.reopen(id);

    const heard = await announcedFailures({ conversations: second.conversations, id });

    expect(heard).toHaveLength(1);
    expect(heard[0]).toMatch(/^2 stored node channels could not be closed as lost/);
  });

  it('announces a channel write that fails while the conversation runs, once, and ends no run', async () => {
    // The run still completes: the stream is the record.
    const { id, conversations } = await ranOnePrompt(failingChannels());

    await written(conversations, id);

    const heard = await announcedFailures({ conversations, id });

    expect(heard).toHaveLength(1);
    expect(heard[0]).toContain('disk gone');
    expect(conversations.get(id).harness.nodeChannels?.failure).toBeDefined();
  });

  it('announces, when a conversation becomes live, a channel write that failed while it was being built', async () => {
    const { id, conversations } = await ranOnePrompt(failingChannels());
    const live = conversations.get(id);

    await live.harness.nodeChannels?.flush();

    // `start` and `reopen` call this once the conversation is live, for a failure that came before
    // there was a stream to say it on: it names the failure the writer holds. The writer already
    // announced this one live, so a spy counts only what this call asks the stream to publish.
    const publish = vi.spyOn(live.harness.sessions, 'publish');

    announceChannelFailures({ live, repairs: [] });

    expect(publish).toHaveBeenCalledTimes(1);
    expect(publish).toHaveBeenCalledWith(
      expect.objectContaining({
        event: expect.objectContaining({
          type: 'storage_failed',
          error: expect.stringContaining('disk gone') as string,
        }) as object,
      }),
    );
  });

  it('closes the channel a stopped process left open as lost when the conversation is reopened', async () => {
    const store = new MemoryConversationStore();
    const { id } = await stoppedConversation(store);
    const [old] = await nodeChannelsOf({ store, id });
    const before = shapeOf(await entriesOf({ store, id, channel: old ?? '' }));
    // A new host on the same store: the first process is gone, and never closed anything.
    const second = setup({ store, replies: [say('two')] });

    await second.conversations.reopen(id);
    await written(second.conversations, id);

    const entries = await entriesOf({ store, id, channel: old ?? '' });

    expect(entries.length).toBe(before.length + 1);
    expect(entries.at(-1)).toMatchObject({ type: 'closed', state: 'lost' });
    expect(entries.at(-1)).not.toHaveProperty('outcome');

    // The reopened conversation goes on with a node of its own, and so a channel of its own.
    const channels = await nodeChannelsOf({ store, id });

    expect(channels).toHaveLength(2);

    const fresh = channels.find((channel) => channel !== old) ?? '';

    expect(shapeOf(await entriesOf({ store, id, channel: fresh }))[0]).toBe('opened s0');
  });

  it('does nothing more when it is reopened again: what was closed stays as it was', async () => {
    const store = new MemoryConversationStore();
    const { id } = await stoppedConversation(store);
    const [old] = await nodeChannelsOf({ store, id });
    const second = setup({ store, replies: [say('two')] });

    await second.conversations.reopen(id);
    await written(second.conversations, id);
    await second.conversations.close(id);

    const afterFirstReopen = await entriesOf({ store, id, channel: old ?? '' });
    const third = setup({ store, replies: [say('three')] });

    await third.conversations.reopen(id);
    await written(third.conversations, id);

    // The channel closed as lost is not closed a second time.
    expect(await entriesOf({ store, id, channel: old ?? '' })).toEqual(afterFirstReopen);
    expect(afterFirstReopen.filter((each) => each.type === 'closed')).toHaveLength(1);
  });

  it('reopens a conversation whose channel is at its limit and cannot be closed', async () => {
    // How much room the first line of the agent's channel takes, from a run on a store with no limit.
    const measured = new MemoryConversationStore();
    const { id: measuredId } = await stoppedConversation(measured);
    const [measuredChannel] = await nodeChannelsOf({ store: measured, id: measuredId });
    const [opened] = await entriesOf({
      store: measured,
      id: measuredId,
      channel: measuredChannel ?? '',
    });
    const line = Buffer.byteLength(JSON.stringify(opened)) + 1;

    // A store with room for that line and no more: the agent's later changes are refused, so the
    // channel holds only `opened`, and the entry that would close it is refused too.
    const store = new MemoryConversationStore({ limits: { channelBytes: line } });
    const { id } = await stoppedConversation(store);
    const [channel] = await nodeChannelsOf({ store, id });
    const second = setup({ store, replies: [say('two')] });

    expect(await second.conversations.reopen(id)).toBe(id);
    expect(shapeOf(await entriesOf({ store, id, channel: channel ?? '' }))).toEqual(['opened s0']);
  });
});

import { describe, expect, it } from 'vitest';
import { StoreError } from '@sheavly/core/errors/store.errors';
import type { ChannelEntry } from '@sheavly/core/store/store.types';
import { MemoryConversationStore } from '@sheavly/testing/store/memory-store.fake';
import type {
  UsageChannelEntry,
  UsageSnapshot,
  UsageView,
} from '@sheavly/protocol/usage/usage.types';
import { emptyUsageFigures } from '@sheavly/protocol/usage/usage.utils';
import { readChannel, shapeOf } from '../../testing/stored-channels.fake.js';
import { conversationId } from '../../testing/stored-conversation.fake.js';
import type { ChannelEvent } from '../nodes.types.js';
import { readStoredChannel } from '../stored-channel.helper.js';
import { StoredChannel } from '../stored-channel.service.js';
import type { ChannelStamp, ResumedChannel } from '../stored-channel.types.js';
import { usageChannelRules } from '../usage-channel-rules.utils.js';

// A stored channel is the machinery every channel of the conversation itself shares. These tests
// run it as the usage channel, which is not the tree: a second view, with its own schema and fold.
// A channel is told its entries by the writer that extends it, so the test's writer lets a test do.

class TestChannel extends StoredChannel<UsageChannelEntry, UsageView, UsageSnapshot> {
  override tell(build: (stamp: ChannelStamp) => ChannelEntry): void {
    super.tell(build);
  }
}

const CALLS = (calls: number) => ({ ...emptyUsageFigures(), calls });
const opened = ({ position, at }: ChannelStamp): ChannelEntry => ({
  channel: 'usage',
  cursor: `s${String(position)}`,
  at,
  type: 'opened',
});
const used =
  (params: { node: string; calls: number }) =>
  ({ position, at }: ChannelStamp): ChannelEntry => ({
    channel: 'usage',
    cursor: `s${String(position)}`,
    at,
    type: 'node_usage',
    usage: { ...CALLS(params.calls), node: params.node },
    total: CALLS(params.calls),
  });

function world(
  params: { store?: MemoryConversationStore; resumed?: ResumedChannel<UsageView> } = {},
) {
  const store = params.store ?? new MemoryConversationStore();
  const failures: StoreError[] = [];
  const heard: ChannelEvent[] = [];
  const channel = new TestChannel({
    ...usageChannelRules,
    log: store.channel({ id: conversationId, channel: 'usage' }),
    onFailure: (failure) => failures.push(failure),
    resumed: params.resumed,
  });

  channel.follow((event) => heard.push(event));

  return { store, channel, failures, heard };
}

/** Tells `channel` its opening and then, for each of `calls`, a change of the main agent's usage. */
function toldOpenedThen(channel: TestChannel, calls: number[]) {
  channel.tell(opened);

  for (const made of calls) channel.tell(used({ node: 'main', calls: made }));
}

/** Stores, straight into the log, the channel's opening and then `second`, as another process left it. */
async function leftOpenedThen(params: {
  store: MemoryConversationStore;
  second: { type: string };
}) {
  const log = params.store.channel({ id: conversationId, channel: 'usage' });

  await log.append({ channel: 'usage', cursor: 's0', at: 1, type: 'opened' });
  await log.append({ channel: 'usage', cursor: 's1', at: 2, ...params.second });
}

const stored = (store: MemoryConversationStore) =>
  readChannel({ store, id: conversationId, channel: 'usage' });
const read = (store: MemoryConversationStore) =>
  readStoredChannel({ ...usageChannelRules, store, id: conversationId });

describe('a stored channel', () => {
  it('numbers each entry it is told, with no gap, and stores them in the order they were told', async () => {
    const { store, channel } = world();

    toldOpenedThen(channel, [1, 2]);
    await channel.flush();

    expect(shapeOf(await stored(store))).toEqual(['opened s0', 'node_usage s1', 'node_usage s2']);
  });

  it('tells its followers each entry once stored, with its place in the log, and not before', async () => {
    const { channel, heard } = world();

    toldOpenedThen(channel, [1]);

    expect(heard).toEqual([]);

    await channel.flush();

    expect(heard.map((event) => (event.type === 'stored' ? event.ordinal : event.type))).toEqual([
      0, 1,
    ]);
  });

  it('gives a snapshot of exactly what is stored, waiting for what was told first', async () => {
    const { channel } = world();

    toldOpenedThen(channel, [1]);
    channel.tell(used({ node: 'helper', calls: 2 }));

    const snapshot = await channel.snapshot();

    expect(snapshot).toMatchObject({ channel: 'usage', cursor: 's2', type: 'snapshot' });
    expect(snapshot.nodes.map(({ node }) => node)).toEqual(['main', 'helper']);
  });

  it('has no snapshot to give before anything is stored', async () => {
    const { channel } = world();

    await expect(channel.snapshot()).rejects.toMatchObject({
      message: 'The usage channel holds nothing yet',
    });
  });

  it('ends on a failed write: nothing more is taken, followers are told, the failure is reported once and the snapshot refuses', async () => {
    const { store, channel, failures, heard } = world();

    channel.tell(opened);
    await channel.flush();
    store.failWith(new Error('disk gone'));
    channel.tell(used({ node: 'main', calls: 1 }));
    await channel.flush();
    store.failWith(undefined);
    channel.tell(used({ node: 'main', calls: 2 }));
    await channel.flush();

    expect(channel.writing()).toBe(false);
    expect(failures).toHaveLength(1);
    expect(failures[0]).toMatchObject({ reason: 'failed', message: 'Storage failed: disk gone' });
    expect(channel.failure).toBe(failures[0]);
    expect(heard.map((event) => event.type)).toEqual(['stored', 'failed']);
    expect(shapeOf(await stored(store))).toEqual(['opened s0']);
    await expect(channel.snapshot()).rejects.toBe(failures[0]);
  });

  it('refuses to store an entry off its contract, another channel’s for one, and ends', async () => {
    const { store, channel, failures } = world();

    channel.tell(({ position, at }) => ({
      channel: 'tree',
      cursor: `s${String(position)}`,
      at,
      type: 'opened',
    }));
    await channel.flush();

    expect(failures).toHaveLength(1);
    expect(failures[0]).toMatchObject({
      message: 'Could not store the conversation’s usage channel',
    });
    expect(channel.writing()).toBe(false);
    expect(await stored(store)).toEqual([]);
  });

  it('stops after writing what was told, tells followers nothing more will come, takes no more and still gives its snapshot', async () => {
    const { store, channel, heard } = world();

    toldOpenedThen(channel, [1]);

    const stopped = channel.stop();

    channel.tell(used({ node: 'main', calls: 2 }));
    await stopped;
    await channel.stop();

    expect(channel.writing()).toBe(false);
    expect(heard.map((event) => event.type)).toEqual(['stored', 'stored', 'failed']);
    expect(shapeOf(await stored(store))).toEqual(['opened s0', 'node_usage s1']);
    expect((await channel.snapshot()).cursor).toBe('s1');
  });

  it('goes on from where a reopened channel stood: the next entry takes the next place, and the view carries on', async () => {
    const first = world();

    first.channel.tell(opened);
    first.channel.tell(used({ node: 'old', calls: 1 }));
    await first.channel.flush();

    const resumed = await read(first.store);
    const second = world({ store: first.store, ...(resumed && { resumed }) });

    expect(second.channel.view.nodes.map(({ node }) => node)).toEqual(['old']);

    second.channel.tell(used({ node: 'new', calls: 2 }));
    await second.channel.flush();

    const snapshot = await second.channel.snapshot();

    expect(snapshot.cursor).toBe('s2');
    expect(snapshot.nodes.map(({ node }) => node)).toEqual(['old', 'new']);
    expect(shapeOf(await stored(first.store))).toEqual([
      'opened s0',
      'node_usage s1',
      'node_usage s2',
    ]);
  });

  it('writes nothing for a channel it could not go on from, and tells why', async () => {
    const failure = new StoreError({ reason: 'invalid', message: 'damaged' });
    const { channel, failures } = world({ resumed: { failure } });

    channel.tell(opened);
    await channel.flush();

    expect(failures).toEqual([failure]);
    expect(channel.writing()).toBe(false);
    await expect(channel.snapshot()).rejects.toBe(failure);
  });
});

describe('reading a stored channel back', () => {
  it('finds none for a conversation that stored none', async () => {
    expect(await read(new MemoryConversationStore())).toBeUndefined();
  });

  it('gives where it stands and the view its entries build', async () => {
    const { store, channel } = world();

    toldOpenedThen(channel, [1, 3]);
    await channel.flush();

    const resumed = await read(store);

    expect(resumed && 'view' in resumed && resumed.next).toBe(3);
    expect(resumed && 'view' in resumed && resumed.last.cursor).toBe('s2');
    expect(resumed && 'view' in resumed && resumed.view.total.calls).toBe(3);
  });

  it('is a failure for a channel that was closed: a closed channel takes no more', async () => {
    const store = new MemoryConversationStore();

    await leftOpenedThen({ store, second: { type: 'closed' } });

    expect(await read(store)).toMatchObject({
      failure: { message: expect.stringContaining('cannot be gone on from') as string },
    });
  });

  it('is a failure for an entry the contract does not take', async () => {
    const store = new MemoryConversationStore();

    await leftOpenedThen({ store, second: { type: 'something_else' } });

    expect(await read(store)).toMatchObject({ failure: { reason: 'invalid' } });
  });
});

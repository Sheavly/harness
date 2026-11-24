import { SessionRegistry } from '../../sessions/sessions.service.js';
import { TaskRegistry } from '../../tasks/tasks.service.js';
import { startControlledTask } from '../../testing/controlled-task.fake.js';
import { readChannel, shapeOf } from '../../testing/stored-channels.fake.js';
import { NodeChannelWriter } from '../node-channel-writer.service.js';
import { describe, expect, it } from 'vitest';
import { StoreError } from '@sheavly/core/errors/store.errors';
import type { ChannelEntry } from '@sheavly/core/store/store.types';
import { channelBoundarySchema } from '@sheavly/protocol/channel/channel.validator';
import { conversationIdSchema } from '@sheavly/protocol/server/server.validator';
import { sessionIdSchema } from '@sheavly/protocol/session/session.validator';
import { useFixedClock } from '@sheavly/testing/clock/fixed-clock.fake';
import { MemoryConversationStore } from '@sheavly/testing/store/memory-store.fake';

const closeLostChannels = async (params: Parameters<typeof NodeChannelWriter.closeLost>[0]) =>
  NodeChannelWriter.closeLost(params);

const id = conversationIdSchema.parse('00000000-0000-4000-8000-0000000000e1');
const clock = useFixedClock();

const entry = (params: { channel: string; type: string; cursor: string }): ChannelEntry => ({
  ...params,
  at: 1,
  node: { id: params.channel, title: 'x' },
});

const entriesOf = async (params: { store: MemoryConversationStore; channel: string }) =>
  readChannel({ ...params, id });

/** A store holding the channels of nodes that were running when the process ended. */
async function stoppedStore() {
  const store = new MemoryConversationStore();
  const append = async (each: ChannelEntry) =>
    store.channel({ id, channel: each.channel }).append(each);

  // An agent that opened and changed, and was never closed.
  await append(entry({ channel: 'agent-1', type: 'opened', cursor: 's0' }));
  await append(entry({ channel: 'agent-1', type: 'updated', cursor: 's1' }));
  // A command that opened and had printed 40 bytes of output.
  await append(entry({ channel: 'cmd-1', type: 'opened', cursor: 'b0' }));
  await append(entry({ channel: 'cmd-1', type: 'updated', cursor: 'b40' }));
  // One that finished before the server stopped.
  await append(entry({ channel: 'done-1', type: 'opened', cursor: 's0' }));
  await append(entry({ channel: 'done-1', type: 'closed', cursor: 's1' }));

  return store;
}

describe('closing the channels a stopped server left open', () => {
  it('ends an unfinished numbered channel as lost at the next number, with no outcome', async () => {
    const store = await stoppedStore();

    clock.advance(5);
    await closeLostChannels({ store, id, at: clock.at });

    const entries = await entriesOf({ store, channel: 'agent-1' });

    expect(shapeOf(entries)).toEqual(['opened s0', 'updated s1', 'closed s2']);
    expect(entries[2]).toEqual({
      channel: 'agent-1',
      cursor: 's2',
      at: clock.at,
      type: 'closed',
      state: 'lost',
    });
    expect(channelBoundarySchema.safeParse(entries[2]).success).toBe(true);
  });

  it('ends an unfinished counted channel at the offset it had reached', async () => {
    const store = await stoppedStore();

    await closeLostChannels({ store, id, at: 9 });

    const entries = await entriesOf({ store, channel: 'cmd-1' });

    expect(shapeOf(entries)).toEqual(['opened b0', 'updated b40', 'closed b40']);
    expect(channelBoundarySchema.safeParse(entries[2]).success).toBe(true);
  });

  it('says which channels it closed, and leaves a channel that ended alone', async () => {
    const store = await stoppedStore();
    const result = await closeLostChannels({ store, id, at: 9 });

    expect(result.closed.toSorted()).toEqual(['agent-1', 'cmd-1']);
    expect(result.full).toEqual([]);
    expect(shapeOf(await entriesOf({ store, channel: 'done-1' }))).toEqual([
      'opened s0',
      'closed s1',
    ]);
  });

  it('changes nothing the second time: the channels it closed already end', async () => {
    const store = await stoppedStore();

    await closeLostChannels({ store, id, at: 9 });

    const before = {
      agent: await entriesOf({ store, channel: 'agent-1' }),
      command: await entriesOf({ store, channel: 'cmd-1' }),
    };
    const again = await closeLostChannels({ store, id, at: 99 });

    expect(again).toEqual({ closed: [], full: [], failed: [] });
    expect(await entriesOf({ store, channel: 'agent-1' })).toEqual(before.agent);
    expect(await entriesOf({ store, channel: 'cmd-1' })).toEqual(before.command);
  });

  it('leaves the tree channel, which is the conversation’s and not a node’s', async () => {
    const store = await stoppedStore();

    await store
      .channel({ id, channel: 'tree' })
      .append(entry({ channel: 'tree', type: 'opened', cursor: 's0' }));

    const result = await closeLostChannels({ store, id, at: 9 });

    expect(result.closed).not.toContain('tree');
    expect(shapeOf(await entriesOf({ store, channel: 'tree' }))).toEqual(['opened s0']);
  });

  it('does nothing for a conversation that stored no channel', async () => {
    const result = await closeLostChannels({ store: new MemoryConversationStore(), id, at: 9 });

    expect(result).toEqual({ closed: [], full: [], failed: [] });
  });

  it('lists a channel at a limit instead of failing, since it already reads as lost', async () => {
    const opened = entry({ channel: 'agent-1', type: 'opened', cursor: 's0' });
    const store = new MemoryConversationStore({
      limits: { channelBytes: Buffer.byteLength(JSON.stringify(opened)) + 1 },
    });

    await store.channel({ id, channel: 'agent-1' }).append(opened);

    const result = await closeLostChannels({ store, id, at: 9 });

    expect(result).toEqual({ closed: [], full: ['agent-1'], failed: [] });
    expect(shapeOf(await entriesOf({ store, channel: 'agent-1' }))).toEqual(['opened s0']);
  });

  it('lists a channel it cannot read, and still repairs the others', async () => {
    const memory = await stoppedStore();
    // One channel's file is damaged: reading it fails, as a line that is not JSON would.
    const damaged = new StoreError({ reason: 'failed', message: 'Stored file n.jsonl is damaged' });
    const store = {
      channels: async (conversation: typeof id) => memory.channels(conversation),
      channel: (params: Parameters<MemoryConversationStore['channel']>[0]) =>
        params.channel === 'agent-1'
          ? {
              append: async () => undefined,
              read: () => {
                throw damaged;
              },
            }
          : memory.channel(params),
    };
    const result = await closeLostChannels({ store, id, at: 9 });

    expect(result.closed).toEqual(['cmd-1']);
    expect(result.failed).toEqual([{ channel: 'agent-1', failure: damaged }]);
    expect(shapeOf(await entriesOf({ store: memory, channel: 'cmd-1' }))).toEqual([
      'opened b0',
      'updated b40',
      'closed b40',
    ]);
  });

  it('lists the channels it cannot close, not throwing, and repairs them when the disk is back', async () => {
    const store = await stoppedStore();

    store.failWith(new Error('disk gone'));

    const failed = await closeLostChannels({ store, id, at: 9 });

    expect(failed.closed).toEqual([]);
    expect(failed.failed.map((each) => each.channel).toSorted()).toEqual(['agent-1', 'cmd-1']);
    expect(failed.failed[0]?.failure).toMatchObject({ name: 'StoreError', reason: 'failed' });

    store.failWith(undefined);

    expect((await closeLostChannels({ store, id, at: 9 })).closed.toSorted()).toEqual([
      'agent-1',
      'cmd-1',
    ]);
  });
});

describe('a conversation that stopped while its nodes ran', () => {
  it('has its agent and command channels closed as lost when it is reopened, once', async () => {
    const store = new MemoryConversationStore();
    const sessions = new SessionRegistry();
    const tasks = new TaskRegistry(sessions.nodeOwners);
    const main = sessions.startMain({ title: 'Main', id: sessionIdSchema.parse('main') });
    const writer = NodeChannelWriter.attach({
      nodes: sessions.nodes,
      tasks,
      storage: { log: (channel) => store.channel({ id, channel }) },
    });

    startControlledTask({
      tasks,
      sessionId: main.id,
      backgroundKind: 'service',
      command: 'npm run dev',
      description: 'dev server',
    });
    sessions.idle({ id: main.id, outcome: 'completed' });
    // The process ends here: nothing closes, nothing is flushed but what was written.
    await writer.flush();

    const channels = await store.channels(id);

    expect(channels).toHaveLength(2);

    const first = await closeLostChannels({ store, id, at: 50 });

    expect(first.closed.toSorted()).toEqual(channels.toSorted());

    for (const channel of channels) {
      const entries = await entriesOf({ store, channel });

      expect(entries.at(-1)).toMatchObject({ type: 'closed', state: 'lost', at: 50 });
    }

    expect(await closeLostChannels({ store, id, at: 60 })).toEqual({
      closed: [],
      full: [],
      failed: [],
    });
  });
});

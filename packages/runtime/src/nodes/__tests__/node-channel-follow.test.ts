import { describe, expect, it } from 'vitest';
import { callIdSchema } from '@sheavly/protocol/message/message.validator';
import { MemoryConversationStore } from '@sheavly/testing/store/memory-store.fake';
import { HeldCloses } from '../../testing/held-closes.fake.js';
import { conversation, entriesOf } from '../../testing/stored-conversation.fake.js';
import type { ChannelEvent } from '../nodes.types.js';

type World = ReturnType<typeof conversation>;

/** Follows `channel`, and gives what it is told, in order, and the stop. */
function hearing(params: { world: World; channel: string }) {
  const heard: ChannelEvent[] = [];
  const stop = params.world.writer.follow({
    channel: params.channel,
    listener: (event) => heard.push(event),
  });

  return { heard, stop };
}

/** What a follower was told, one line each: `type cursor #place`, or `failed`. */
const told = (heard: ChannelEvent[]) =>
  heard.map((event) =>
    event.type === 'stored'
      ? `${event.entry.type} ${event.entry.cursor} #${String(event.ordinal)}`
      : event.type,
  );

/** The agent's whole life: a change to idle and back, then its end. */
function liveAndEnd(world: World) {
  world.sessions.idle({ id: world.main.id, outcome: 'completed' });
  world.sessions.resume(world.main.id);
  world.sessions.end({ id: world.main.id, state: 'completed' });
}

describe('following a stored channel', () => {
  it('tells a follower each entry the channel takes, in order, with its place in the log', async () => {
    const world = conversation();
    const { heard } = hearing({ world, channel: world.nodeOf(world.main.id) });

    liveAndEnd(world);
    await world.writer.flush();

    expect(told(heard)).toEqual(['opened s0 #0', 'updated s1 #1', 'updated s2 #2', 'closed s3 #3']);
  });

  it('tells what the store holds, entry for entry, at the place the log has it', async () => {
    const world = conversation();
    const channel = world.nodeOf(world.main.id);
    const { heard } = hearing({ world, channel });

    liveAndEnd(world);

    const stored = await entriesOf({ world, channel });
    const entries = heard.flatMap((event) => (event.type === 'stored' ? [event.entry] : []));
    const places = heard.flatMap((event) => (event.type === 'stored' ? [event.ordinal] : []));

    expect(entries).toEqual(stored);
    expect(places).toEqual(stored.map((_entry, index) => index));
  });

  it('tells a sub-agent’s opened entry as it was stored, with where its parent stood', async () => {
    const world = conversation();
    const parent = world.nodeOf(world.main.id);
    const child = world.sessions.startChild({
      parentId: world.main.id,
      startedByCall: callIdSchema.parse('call_1'),
      title: 'Reader',
    });
    const { heard } = hearing({ world, channel: world.nodeOf(child.id) });

    await world.writer.flush();

    expect(heard).toHaveLength(1);
    expect(heard[0]).toMatchObject({
      type: 'stored',
      ordinal: 0,
      entry: { type: 'opened', cursor: 's0', spawnedAt: { channel: parent, cursor: 's0' } },
    });
  });

  it('tells a follower of one channel nothing of another', async () => {
    const world = conversation();
    const main = hearing({ world, channel: world.nodeOf(world.main.id) });
    const child = world.sessions.startChild({
      parentId: world.main.id,
      startedByCall: callIdSchema.parse('call_1'),
      title: 'Reader',
    });
    const reader = hearing({ world, channel: world.nodeOf(child.id) });

    world.sessions.idle({ id: world.main.id, outcome: 'completed' });
    await world.writer.flush();

    expect(told(main.heard)).toEqual(['opened s0 #0', 'updated s1 #1']);
    expect(told(reader.heard)).toEqual(['opened s0 #0']);
  });

  it('does not tell what was stored before it followed, but its place says where it joins', async () => {
    const world = conversation();
    const channel = world.nodeOf(world.main.id);

    await world.writer.flush();

    const { heard } = hearing({ world, channel });

    expect(heard).toEqual([]);

    world.sessions.idle({ id: world.main.id, outcome: 'completed' });
    await world.writer.flush();

    // The one entry the store already held is #0; the follower hears from #1.
    expect(told(heard)).toEqual(['updated s1 #1']);
  });

  it('stops telling a follower that stopped, and goes on telling the others', async () => {
    const world = conversation();
    const channel = world.nodeOf(world.main.id);
    const first = hearing({ world, channel });
    const second = hearing({ world, channel });

    await world.writer.flush();
    first.stop();
    world.sessions.idle({ id: world.main.id, outcome: 'completed' });
    await world.writer.flush();

    expect(told(first.heard)).toEqual(['opened s0 #0']);
    expect(told(second.heard)).toEqual(['opened s0 #0', 'updated s1 #1']);
  });

  it('tells every follower of a channel the store refuses that it failed, once, and nothing after', async () => {
    // One channel only: the sub-agent's is one too many, refused at its first entry.
    const world = conversation({
      store: new MemoryConversationStore({ limits: { conversationChannels: 1 } }),
    });
    const child = world.sessions.startChild({
      parentId: world.main.id,
      startedByCall: callIdSchema.parse('call_1'),
      title: 'Reader',
    });
    const channel = world.nodeOf(child.id);
    const first = hearing({ world, channel });
    const second = hearing({ world, channel });

    await world.writer.flush();
    world.sessions.end({ id: child.id, state: 'completed' });
    await world.writer.flush();

    expect(told(first.heard)).toEqual(['failed']);
    expect(told(second.heard)).toEqual(['failed']);
  });

  it('keeps telling a channel’s followers of what it stores, when another channel failed', async () => {
    const world = conversation({
      store: new MemoryConversationStore({ limits: { conversationChannels: 1 } }),
    });
    const { heard } = hearing({ world, channel: world.nodeOf(world.main.id) });

    world.sessions.startChild({
      parentId: world.main.id,
      startedByCall: callIdSchema.parse('call_1'),
      title: 'Reader',
    });
    liveAndEnd(world);
    await world.writer.flush();

    expect(told(heard)).toEqual(['opened s0 #0', 'updated s1 #1', 'updated s2 #2', 'closed s3 #3']);
  });

  it('says it writes a channel while its node lives, and not after it ended, failed or was unknown', async () => {
    const world = conversation({
      store: new MemoryConversationStore({ limits: { conversationChannels: 1 } }),
    });
    const main = world.nodeOf(world.main.id);
    const child = world.sessions.startChild({
      parentId: world.main.id,
      startedByCall: callIdSchema.parse('call_1'),
      title: 'Reader',
    });

    await world.writer.flush();

    expect(world.writer.writing(main)).toBe(true);
    // The sub-agent's channel was refused at its first entry: it takes no more.
    expect(world.writer.writing(world.nodeOf(child.id))).toBe(false);
    expect(world.writer.writing('no-such-node')).toBe(false);

    liveAndEnd(world);
    await world.writer.flush();

    expect(world.writer.writing(main)).toBe(false);
  });

  it('says it still writes a channel whose node ended but whose closed entry is not stored yet', async () => {
    const store = new HeldCloses();
    const world = conversation({ store });
    const main = world.nodeOf(world.main.id);
    const { heard } = hearing({ world, channel: main });

    await world.writer.flush();
    world.sessions.end({ id: world.main.id, state: 'completed' });
    await store.reached.promise;

    // The node has ended, and the store does not have its `closed` entry yet: it is still coming.
    expect(world.writer.writing(main)).toBe(true);
    expect(told(heard)).toEqual(['opened s0 #0']);

    store.release();
    await world.writer.flush();

    expect(told(heard)).toEqual(['opened s0 #0', 'closed s1 #1']);
    expect(world.writer.writing(main)).toBe(false);
  });

  it('does not say it writes a channel that failed, even while its closed entry waits', async () => {
    const store = new MemoryConversationStore();
    const world = conversation({ store });
    const main = world.nodeOf(world.main.id);

    // The disk refuses one write and is mended: the channel has an entry missing, so it takes no more.
    store.failWith(new Error('read-only disk'));
    world.sessions.idle({ id: world.main.id, outcome: 'completed' });
    await world.writer.flush();
    store.failWith(undefined);
    world.sessions.resume(world.main.id);
    world.sessions.end({ id: world.main.id, state: 'completed' });

    // Its `closed` entry is queued behind nothing, and will not be tried: the channel failed.
    expect(world.writer.writing(main)).toBe(false);

    await world.writer.flush();

    expect(world.writer.writing(main)).toBe(false);
  });

  it('is not told of a channel nothing writes, and the writer is not troubled by the asking', async () => {
    const world = conversation();
    const { heard, stop } = hearing({ world, channel: 'no-such-node' });

    liveAndEnd(world);
    await world.writer.flush();
    stop();

    expect(heard).toEqual([]);
    expect(world.failures).toEqual([]);
  });
});

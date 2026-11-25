import { describe, expect, it, vi } from 'vitest';
import { HeldCloses } from '@sheavly/runtime/testing/held-closes.fake';
import { conversation, conversationId } from '@sheavly/runtime/testing/stored-conversation.fake';
import {
  PausedReads,
  agent,
  open,
  plain,
  rest,
  spawn,
  take,
  wholeLife,
} from '../../testing/subscription-world.fake.js';
import { HeldBytes } from '../held-bytes.service.js';
import { bytesOfFrame } from '../subscription-frames.utils.js';
import { readSelection } from '../subscription-read.helper.js';

/** The bytes the frames of a whole life count, one at a time, for a pool of exactly that. */
async function sizes() {
  const { world, main } = agent();

  await wholeLife(world);

  const frames = await rest((await open({ world, channels: [[main, 'start']] })).frames());

  return frames.map((frame) => bytesOfFrame(frame));
}

describe('what a conversation’s subscriptions hold together', () => {
  it('refuses history that does not fit, and gives back all that waited when a subscription ends', async () => {
    const [opened = 0, updated1 = 0, updated2 = 0, closed = 0] = await sizes();
    const history = opened + updated1 + updated2 + closed;
    const { world, main } = agent();

    await wholeLife(world);

    // Room for one whole history and not for two.
    const pool = new HeldBytes(history + opened);
    const first = await open({ world, channels: [[main, 'start']], pool });

    await expect(open({ world, channels: [[main, 'start']], pool })).rejects.toMatchObject({
      reason: 'too_many_subscriptions',
    });

    // The first is read to its end: what it held is given back, and the refused one gave back what
    // it had taken (the opened entry) before it failed.
    await rest(first.frames());

    const again = await open({ world, channels: [[main, 'start']], pool });

    // All the room is there again: a whole history and one more entry fit, not only the history.
    // Had the refused request kept its bytes, the last of these would not fit.
    const last = await open({ world, channels: [[main, 's2']], pool });

    expect(closed).toBeLessThanOrEqual(opened);
    expect(plain(await rest(again.frames()))).toHaveLength(5);
    expect(plain(await rest(last.frames()))).toEqual(['closed s3', 'end:completed s3']);
  });

  it('gives back what waits when a subscription is closed unread', async () => {
    const [opened = 0, updated1 = 0, updated2 = 0, closed = 0] = await sizes();
    const { world, main } = agent();

    await wholeLife(world);

    const pool = new HeldBytes(opened + updated1 + updated2 + closed);
    const unread = await open({ world, channels: [[main, 'start']], pool });

    unread.close();

    // All of it was given back, so a subscription of the same size fits again.
    const next = await open({ world, channels: [[main, 'start']], pool });

    expect(plain(await rest(next.frames()))).toHaveLength(5);
  });

  it('cuts a channel off when its live frames do not fit, and the cut says where it resumes', async () => {
    const [opened = 0] = await sizes();
    const { world, main } = agent();

    await world.writer.flush();

    // Room for the history and not for the next entry.
    const subscription = await open({
      world,
      channels: [[main, 'start']],
      pool: new HeldBytes(opened + 10),
    });

    world.sessions.idle({ id: world.main.id, outcome: 'completed' });
    await world.writer.flush();

    expect(plain(await rest(subscription.frames()))).toEqual(['opened s0', 'end:cut_off s0']);
  });

  it('always has room for the end of a channel, however much is held', async () => {
    const [opened = 0] = await sizes();
    const { world, main } = agent();

    await world.writer.flush();
    world.sessions.end({ id: world.main.id, state: 'completed' });
    await world.writer.flush();

    // Exactly the history: nothing is left for anything else, and the end frame still comes.
    const subscription = await open({
      world,
      channels: [[main, 'start']],
      pool: new HeldBytes(opened + (await sizes()).at(-2)!),
    });

    expect(plain(await rest(subscription.frames())).at(-1)).toBe('end:completed s1');
  });
});

describe('the history of several channels read for one request', () => {
  it('gives back what the first channel’s read held when the second does not fit', async () => {
    const { world, main } = agent();
    const reader = spawn(world);
    const child = world.nodeOf(reader.id);

    world.sessions.end({ id: reader.id, state: 'completed' });
    await wholeLife(world);

    // What reading the whole main channel holds, measured with room to spare.
    const history = (
      await readSelection({
        log: world.store.channel({ id: conversationId, channel: main }),
        from: 'start',
        kind: 'sequence',
        budget: { left: 1_000_000 },
        pool: new HeldBytes(1_000_000),
      })
    ).held;
    // Room for the main channel and one byte more: the child's channel does not fit after it.
    const pool = new HeldBytes(history + 1);

    await expect(
      open({
        world,
        channels: [
          [main, 'start'],
          [child, 'start'],
        ],
        pool,
      }),
    ).rejects.toMatchObject({ reason: 'too_many_subscriptions' });

    // Nothing stayed held: the main channel alone fits again, as the whole pool is free.
    const again = await open({ world, channels: [[main, 'start']], pool });

    expect(plain(await rest(again.frames())).at(-1)).toBe('end:completed s3');
  });
});

describe('a node that has ended and whose last entry is not stored yet', () => {
  it('is joined to its closed entry, and not ended as failed', async () => {
    const store = new HeldCloses();
    const world = conversation({ store });
    const main = world.nodeOf(world.main.id);

    await world.writer.flush();
    world.sessions.end({ id: world.main.id, state: 'completed' });
    await store.reached.promise;

    // The store holds `opened` only, and `closed` is on its way.
    const subscription = await open({ world, channels: [[main, 'start']] });
    const frames = subscription.frames();

    expect(plain(await take(frames, 1))).toEqual(['opened s0']);

    store.release();

    expect(plain(await rest(frames))).toEqual(['closed s1', 'end:completed s1']);
  });
});

describe('a client that leaves while the history is read', () => {
  it('stops the read, and gives back what it held', async () => {
    const store = new PausedReads('after');
    const world = conversation({ store });
    const main = world.nodeOf(world.main.id);
    const leaving = new AbortController();
    const closed = vi.fn();

    await world.writer.flush();

    const opening = open({ world, channels: [[main, 'start']], signal: leaving.signal, closed });

    // The read waits; the client goes; the read goes on and finds it.
    await store.reading.promise;
    leaving.abort();
    store.release();

    await expect(opening).rejects.toMatchObject({ name: 'AbortError' });
    expect(closed).toHaveBeenCalledOnce();
  });
});

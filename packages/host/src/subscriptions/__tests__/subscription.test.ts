import { describe, expect, it, vi } from 'vitest';
import { conversation, conversationId } from '@sheavly/runtime/testing/stored-conversation.fake';
import { MemoryConversationStore } from '@sheavly/testing/store/memory-store.fake';
import { SubscriptionError } from '../../errors/subscription.errors.js';
import {
  agent,
  churn,
  finishLife,
  idleAgent,
  line,
  open,
  pausedStart,
  plain,
  rest,
  spawn,
  take,
  wholeLife,
} from '../../testing/subscription-world.fake.js';
import { MAX_QUEUED_FRAMES } from '../subscriptions.constants.js';

describe('a subscription to a channel being written', () => {
  it('sends its stored history, then each entry stored after, once and in order', async () => {
    const { world, main } = await idleAgent();
    const frames = (await open({ world, channels: [[main, 'start']] })).frames();

    expect(plain(await take(frames, 2))).toEqual(['opened s0', 'updated s1']);

    // The channel closes, so it ends, and with it the frames.
    expect(await finishLife({ world, frames })).toEqual([
      'updated s2',
      'closed s3',
      'end:completed s3',
    ]);
  });

  it.each([
    ['now', ['head s1', 'updated s2', 'closed s3', 'end:completed s3']],
    ['s0', ['updated s1', 'updated s2', 'closed s3', 'end:completed s3']],
    ['tail:1', ['updated s1', 'updated s2', 'closed s3', 'end:completed s3']],
  ])('starts a live channel at %s', async (from, expected) => {
    const { world, main } = await idleAgent();
    const frames = (await open({ world, channels: [[main, from]] })).frames();

    expect(await finishLife({ world, frames })).toEqual(expected);
  });

  it.each([
    ['tail:2', ['updated s2', 'closed s3', 'end:completed s3']],
    ['s1', ['updated s2', 'closed s3', 'end:completed s3']],
    ['now', ['head s3', 'end:completed s3']],
  ])('starts a channel that closed at %s, and says it is over', async (from, expected) => {
    const { world, main } = agent();

    await wholeLife(world);

    expect(plain(await rest((await open({ world, channels: [[main, from]] })).frames()))).toEqual(
      expected,
    );
  });

  it('refuses a cursor the channel does not hold, and gives back what it held', async () => {
    const { world, main } = agent();
    const closed = vi.fn();

    await world.writer.flush();

    await expect(open({ world, channels: [[main, 's9']], closed })).rejects.toMatchObject({
      reason: 'cursor_out_of_range',
    });
    await expect(open({ world, channels: [[main, 's9']] })).rejects.toBeInstanceOf(
      SubscriptionError,
    );
    expect(closed).toHaveBeenCalledOnce();
  });
});

describe('what is written while the history is read', () => {
  const lives = ['opened s0', 'updated s1', 'updated s2', 'closed s3', 'end:completed s3'];

  it.each(['before', 'after'] as const)(
    'is sent once, with no gap, when the read took the channel as it was %s the writes',
    async (when) => {
      const { store, world, opening } = await pausedStart(when);

      // The read has begun and waits. Two entries are stored and told meanwhile.
      churn({ world, cycles: 1 });
      await world.writer.flush();
      store.release();

      const subscription = await opening;

      world.sessions.end({ id: world.main.id, state: 'completed' });

      expect(plain(await rest(subscription.frames()))).toEqual(lives);
    },
  );

  it('ends a channel that closed while it was read, after the closed entry the read missed', async () => {
    const { store, world, opening } = await pausedStart('before');

    world.sessions.idle({ id: world.main.id, outcome: 'completed' });
    world.sessions.end({ id: world.main.id, state: 'completed' });
    await world.writer.flush();
    store.release();

    expect(plain(await rest((await opening).frames()))).toEqual([
      'opened s0',
      'updated s1',
      'closed s2',
      'end:completed s2',
    ]);
  });

  it('cuts a channel off, at what was sent, when more is written meanwhile than a subscription holds', async () => {
    const { store, world, opening } = await pausedStart('before');

    churn({ world, cycles: MAX_QUEUED_FRAMES / 2 + 1 });
    await world.writer.flush();
    store.release();

    expect(plain(await rest((await opening).frames()))).toEqual(['opened s0', 'end:cut_off s0']);
  });
});

describe('several channels in one subscription', () => {
  it('keeps each channel’s frames its own, and ends when every channel has', async () => {
    const { world, main } = agent();
    const reader = spawn(world);
    const child = world.nodeOf(reader.id);

    await world.writer.flush();

    const frames = (
      await open({
        world,
        channels: [
          [main, 'now'],
          [child, 'start'],
        ],
      })
    ).frames();

    // The sub-agent ends first, as a parent cannot end while it runs.
    world.sessions.end({ id: reader.id, state: 'completed' });
    world.sessions.idle({ id: world.main.id, outcome: 'completed' });
    world.sessions.end({ id: world.main.id, state: 'completed' });

    const heard = (await rest(frames)).map(line);
    const of = (channel: string) => heard.filter((each) => each.startsWith(channel));

    expect(of(main)).toEqual([
      `${main} head s0`,
      `${main} updated s1`,
      `${main} closed s2`,
      `${main} end:completed s2`,
    ]);
    expect(of(child)).toEqual([
      `${child} opened s0`,
      `${child} closed s1`,
      `${child} end:completed s1`,
    ]);
  });

  it('cuts off the channel whose consumer does not keep up, and only that one', async () => {
    const { world, main } = agent();
    const child = spawn(world);
    const childNode = world.nodeOf(child.id);

    await world.writer.flush();

    const subscription = await open({
      world,
      channels: [
        [main, 'start'],
        [childNode, 'start'],
      ],
    });

    // Nobody reads: more live entries pile up on the main agent's channel than a subscription holds.
    churn({ world, cycles: MAX_QUEUED_FRAMES / 2 + 1 });
    await world.writer.flush();
    world.sessions.end({ id: child.id, state: 'completed' });

    const heard = (await rest(subscription.frames())).map(line);

    // What was sent of the main channel is its history, and the cut says where it resumes: after
    // the last entry the consumer got. The child's channel goes on to its end.
    expect(heard.filter((each) => each.startsWith(main))).toEqual([
      `${main} opened s0`,
      `${main} end:cut_off s0`,
    ]);
    expect(heard.filter((each) => each.startsWith(childNode))).toEqual([
      `${childNode} opened s0`,
      `${childNode} closed s1`,
      `${childNode} end:completed s1`,
    ]);
  });
});

describe('a channel that stops being written', () => {
  it('ends as failed, at the last cursor sent, when its storage fails', async () => {
    const store = new MemoryConversationStore();
    const world = conversation({ store });
    const main = world.nodeOf(world.main.id);

    await world.writer.flush();

    const frames = (await open({ world, channels: [[main, 'start']] })).frames();

    expect(plain(await take(frames, 1))).toEqual(['opened s0']);

    store.failWith(new Error('disk gone'));
    world.sessions.idle({ id: world.main.id, outcome: 'completed' });

    expect(plain(await rest(frames))).toEqual(['end:failed s0']);
  });

  const orphan = (cursor: string, type: string, more: object = {}) => ({
    channel: 'orphan',
    cursor,
    at: 1,
    type,
    ...more,
  });
  const orphanNode = { kind: 'agent', id: 'orphan', title: 'Gone', state: 'running', startedAt: 1 };

  it('ends as failed after its history when no writer has it, whatever the position', async () => {
    const world = conversation();

    await world.store
      .channel({ id: conversationId, channel: 'orphan' })
      .append(orphan('s0', 'opened', { node: orphanNode }));

    for (const [from, expected] of [
      ['start', ['opened s0', 'end:failed s0']],
      ['now', ['head s0', 'end:failed s0']],
    ] as const) {
      const subscription = await open({ world, channels: [['orphan', from]] });

      expect(plain(await rest(subscription.frames()))).toEqual(expected);
    }
  });

  it('ends as failed rather than send an entry the contract does not know', async () => {
    const world = conversation();
    const log = world.store.channel({ id: conversationId, channel: 'orphan' });

    await log.append(orphan('s0', 'opened', { node: orphanNode }));
    await log.append(orphan('s1', 'note'));

    const subscription = await open({ world, channels: [['orphan', 'start']] });

    expect(plain(await rest(subscription.frames()))).toEqual(['opened s0', 'end:failed s0']);
  });
});

describe('closing a subscription', () => {
  it('gives back what it held once, whether it was closed or read to its end', async () => {
    const { world, main } = agent();
    const closed = vi.fn();

    await world.writer.flush();

    const subscription = await open({ world, channels: [[main, 'start']], closed });

    subscription.close();
    subscription.close();

    expect(closed).toHaveBeenCalledOnce();
    expect(await rest(subscription.frames())).toEqual([]);

    const ended = vi.fn();
    const finished = await open({ world, channels: [[main, 'start']], closed: ended });
    const frames = finished.frames();

    await take(frames, 1);
    world.sessions.end({ id: world.main.id, state: 'completed' });
    await rest(frames);

    expect(ended).toHaveBeenCalledOnce();
  });

  it('stops hearing the writer once closed, and the writer is not troubled', async () => {
    const { world, main } = agent();

    await world.writer.flush();

    const subscription = await open({ world, channels: [[main, 'start']] });

    subscription.close();
    await wholeLife(world);

    expect(world.failures).toEqual([]);
    expect(await rest(subscription.frames())).toEqual([]);
  });
});

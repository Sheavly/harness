import { describe, expect, it } from 'vitest';
import { collect } from '@sheavly/testing/fetch/fake-fetch.fake';
import { readChannel } from '@sheavly/runtime/testing/stored-channels.fake';
import type { ChannelEntry } from '@sheavly/core/store/store.types';
import { isConversationChannel } from '@sheavly/protocol/channel/channel.utils';
import { agentEventSchema, entryEventSchema } from '@sheavly/protocol/event/event.validator';
import type { ConversationId } from '@sheavly/protocol/server/server.types';
import type { SubscribeFrame } from '@sheavly/protocol/subscription/subscription.types';
import { MemoryConversationStore } from '@sheavly/testing/store/memory-store.fake';
import { say, scriptedConversations } from '../../testing/conversations.fake.js';
import { refusalOf, requestOf } from '../../testing/subscription-world.fake.js';
import type { Conversations } from '../conversations.service.js';

/** The cursors of the entries among `frames`: everything but the head, the end and a live frame. */
const cursorsOf = (frames: SubscribeFrame[]) =>
  frames.flatMap((frame) =>
    frame.type === 'head' || frame.type === 'end' || frame.type === 'live' ? [] : [frame.cursor],
  );

/** A frame as `type cursor`, or `event cursor eventType` for an entry that wraps an event. */
const tag = (frame: SubscribeFrame) => {
  if (frame.type === 'end') return `end:${frame.reason}`;

  if (frame.type === 'live') return 'live';

  if (frame.type === 'event') return `event ${frame.cursor} ${frame.event.type}`;

  return `${frame.type} ${frame.cursor}`;
};

/** An entry as the frame the subscription sends for it, for a test that compares the two. */
const frameTagOf = (entry: ChannelEntry) =>
  entry.type === 'event'
    ? `event ${entry.cursor} ${(entry.event as { type: string }).type}`
    : `${entry.type} ${entry.cursor}`;

/** A conversation that ran `prompts` (the model says "one", "two", …), and its main agent's channel. */
async function ranPrompts(count: number) {
  const store = new MemoryConversationStore();
  const { conversations } = scriptedConversations({
    store,
    replies: ['one', 'two', 'three', 'four'].map((text) => say(text)),
  });
  const id = await conversations.start();
  const prompt = async (text: string) => {
    await collect((await conversations.send({ id, prompt: { text } })).events);
    await conversations.get(id).harness.nodeChannels?.flush();
  };

  for (let turn = 0; turn < count; turn += 1) await prompt(`prompt ${String(turn)}`);

  const [channel = ''] = (await store.channels(id)).filter((name) => !isConversationChannel(name));

  return { store, id, conversations, channel, prompt };
}

/** What a test asks of a conversation: a subscription to `channel` from `from`. */
type Ask = { conversations: Conversations; id: ConversationId; channel: string; from: string };

const subscribeTo = ({ conversations, id, channel, from }: Ask) =>
  conversations.subscribe({ id, request: requestOf(channel, from) });

/** What a subscription from `from` sends of the channel, up to what is stored now. */
async function heardFrom(ask: Ask) {
  const { conversations, id } = ask;
  const subscription = await subscribeTo(ask);
  const frames: SubscribeFrame[] = [];

  // A live channel does not end: take what is stored by asking the conversation to close after.
  const reading = (async () => {
    for await (const frame of subscription.frames()) frames.push(frame);
  })();

  await conversations.close(id);
  await reading;

  return frames;
}

describe('a conversation’s main agent channel, after it ran a prompt', () => {
  it('holds the run: its events between opened and closed, in the order the loop sent them', async () => {
    const { store, id, channel, conversations } = await ranPrompts(1);

    await conversations.close(id);

    const entries = await readChannel({ store, id, channel });
    const types = entries.map((entry) =>
      entry.type === 'event' ? (entry.event as { type: string }).type : entry.type,
    );

    expect(types[0]).toBe('opened');
    expect(types).toContain('text_delta');
    expect(types).toContain('turn_end');
    expect(types.at(-1)).toBe('closed');
    // The prompt's text, its end, and the run's end come in the order the loop sent them.
    expect(types.indexOf('text_delta')).toBeLessThan(types.indexOf('turn_end'));
    expect(types.indexOf('turn_end')).toBeLessThan(types.indexOf('done'));
    expect(entries.map((entry) => entry.cursor)).toEqual(entries.map((_, at) => `s${String(at)}`));
  });

  it('holds events the protocol parses, each with its own seq in the order of the session', async () => {
    const { store, id, channel, conversations } = await ranPrompts(1);

    await conversations.close(id);

    const seqs: number[] = [];

    for (const entry of await readChannel({ store, id, channel })) {
      if (entry.type !== 'event') continue;

      const event = entryEventSchema.parse(entry.event);

      seqs.push(event.seq);
    }

    expect(seqs.length).toBeGreaterThan(2);
    expect(seqs).toEqual([...seqs].sort((a, b) => a - b));
  });
});

describe('a channel longer than one request may read', () => {
  /** A conversation whose main agent's channel holds more than `MAX_SUBSCRIBE_READ_BYTES` of events. */
  async function longChannel() {
    const world = await ranPrompts(1);
    const { harness } = world.conversations.get(world.id);
    const content = 'x'.repeat(60_000);

    // A tool result of 60 KB fits an entry whole, and 150 of them are about 9 MB.
    for (let seq = 100; seq < 250; seq += 1) {
      harness.sessions.publish({
        sessionId: harness.mainSession.id,
        event: agentEventSchema.parse({
          seq,
          type: 'tool_result',
          call: { id: 'call-1', name: 'read_file', input: {} },
          description: 'reading',
          message: { role: 'tool', toolCallId: 'call-1', content, isError: false },
          durationMs: 1,
        }),
      });
    }

    await harness.nodeChannels?.flush();

    return world;
  }

  /** The first frame a subscription from `from` sends, and it is closed. */
  async function firstFrame(ask: Ask) {
    const subscription = await subscribeTo(ask);
    const first = await subscription.frames().next();

    subscription.close();

    return first.done ? undefined : first.value;
  }

  it('refuses start, which would send all of it, and says to ask from a cursor or a tail', async () => {
    const { conversations, id, channel } = await longChannel();

    expect(
      await refusalOf(conversations.subscribe({ id, request: requestOf(channel, 'start') })),
    ).toMatchObject({
      reason: 'bad_request',
      message: expect.stringContaining('subscribe from a cursor or a tail') as string,
    });
  });

  it('serves a tail, a cursor near the end and now, since each sends little', async () => {
    const { store, conversations, id, channel } = await longChannel();
    const stored = await readChannel({ store, id, channel });
    const newest = stored.at(-1)?.cursor ?? '';
    const near = `s${String(stored.length - 4)}`;

    expect(await firstFrame({ conversations, id, channel, from: 'tail:50' })).toMatchObject({
      type: 'event',
      cursor: `s${String(stored.length - 50)}`,
    });
    expect(await firstFrame({ conversations, id, channel, from: near })).toMatchObject({
      cursor: `s${String(stored.length - 3)}`,
    });
    expect(await firstFrame({ conversations, id, channel, from: 'now' })).toMatchObject({
      type: 'head',
      cursor: newest,
    });
  });
});

describe('subscribing to the main agent’s channel of a conversation that ran', () => {
  it('serves the whole run from the start, and ends with the conversation', async () => {
    const { store, id, channel, conversations } = await ranPrompts(2);
    const frames = await heardFrom({ conversations, id, channel, from: 'start' });
    const entries = await readChannel({ store, id, channel });

    expect(frames.map(tag)).toEqual([...entries.map(frameTagOf), 'end:completed']);
  });

  it.each([
    ['tail:2', 2],
    ['tail:5', 5],
  ])('serves the last entries from %s, then what is written after', async (from, count) => {
    const { store, id, channel, conversations } = await ranPrompts(1);
    const stored = await readChannel({ store, id, channel });
    const sent = cursorsOf(await heardFrom({ conversations, id, channel, from }));

    // The history is the last `count` of what was stored when it asked; each cursor comes once.
    expect(sent.slice(0, count)).toEqual(stored.slice(-count).map((entry) => entry.cursor));
    expect(new Set(sent).size).toBe(sent.length);
  });

  it('serves what follows a cursor the client kept, from the middle of the run', async () => {
    const { store, id, channel, conversations } = await ranPrompts(1);
    const stored = await readChannel({ store, id, channel });
    const middle = Math.floor(stored.length / 2);
    const sent = cursorsOf(
      await heardFrom({ conversations, id, channel, from: `s${String(middle)}` }),
    );

    expect(sent.slice(0, stored.length - middle - 1)).toEqual(
      stored.slice(middle + 1).map((entry) => entry.cursor),
    );
    expect(new Set(sent).size).toBe(sent.length);
  });

  it('says where the channel stands from now, and sends nothing before it', async () => {
    const { store, id, channel, conversations } = await ranPrompts(1);
    const entries = await readChannel({ store, id, channel });
    const frames = await heardFrom({ conversations, id, channel, from: 'now' });

    expect(frames[0]).toMatchObject({ type: 'head', cursor: entries.at(-1)?.cursor });
  });

  it('is told what comes while it is connected, once and in order, and a reconnect from its last cursor misses nothing and repeats nothing', async () => {
    const { store, id, channel, conversations, prompt } = await ranPrompts(1);
    const before = (await readChannel({ store, id, channel })).at(-1)?.cursor ?? '';
    const subscription = await conversations.subscribe({ id, request: requestOf(channel, before) });
    const heard: string[] = [];
    const reading = (async () => {
      for await (const frame of subscription.frames()) heard.push(...cursorsOf([frame]));
    })();

    await prompt('second');
    // The connection is cut here: what was heard is what came before, and the client keeps its last.
    subscription.close();
    await reading;

    const last = heard.at(-1) ?? before;

    // A third prompt runs while the client is away.
    await prompt('third');

    const stored = (await readChannel({ store, id, channel })).map((entry) => entry.cursor);
    const again = await conversations.subscribe({ id, request: requestOf(channel, last) });
    const after: string[] = [];
    const reconnected = (async () => {
      for await (const frame of again.frames()) after.push(...cursorsOf([frame]));
    })();

    await conversations.close(id);
    await reconnected;

    const closed = (await readChannel({ store, id, channel })).map((entry) => entry.cursor);

    expect(stored.length).toBeGreaterThan(before.length);
    expect(heard.length).toBeGreaterThan(0);
    // What it heard before the cut, and after the reconnect, is the channel from where it stood:
    // every cursor once, with no gap.
    expect([...heard, ...after]).toEqual(closed.slice(closed.indexOf(before) + 1));
  });
});

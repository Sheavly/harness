import { ZodError } from 'zod';
import { describe, expect, it } from 'vitest';
import { conversationIdSchema } from '@sheavly/protocol/server/server.validator';
import type { SubscribeFrame } from '@sheavly/protocol/subscription/subscription.types';
import { subscribeRequestSchema } from '@sheavly/protocol/subscription/subscription.validator';
import { RefusedError, StreamLostError } from '../../errors/client.errors.js';
import { fakeServer } from '../../testing/fake-server.fake.js';
import {
  agentOpened,
  agentUpdated,
  channelOf,
  commandClosed,
  endedAs,
  headAt,
  outputText,
} from '../../testing/frames.fake.js';
import type { FakeCall, FakeRefusal } from '../../testing/testing.types.js';
import { createClient } from '../client.helper.js';
import type { ReconnectPolicy } from '../client.types.js';
import { subscribeChannels } from '../subscribe.helper.js';

const ID = conversationIdSchema.parse('00000000-0000-4000-8000-0000000000ab');

/** What one connection sends: its frames in order, an Error where it drops, a clean end after the last. */
type SentFrames = (SubscribeFrame | Error)[];

async function* sends(script: SentFrames): AsyncGenerator<SubscribeFrame> {
  for (const item of script) {
    if (item instanceof Error) throw item;

    yield item;
  }
}

const DROP = new TypeError('terminated');

/** Two agents' channels, both followed from their start. */
const A_AND_B: [string, string][] = [
  ['a', 'start'],
  ['b', 'start'],
];

/**
 * A backend that answers the n-th subscribe request with the n-th of `connections` (a refusal, or
 * what it sends), and a client for it that never sleeps between attempts. `asked` is what each
 * request asked for, as the contract parses it.
 */
function served(params: {
  connections: (SentFrames | FakeRefusal)[];
  reconnect?: ReconnectPolicy;
}) {
  let opened = 0;
  const { fetch, calls } = fakeServer({
    streamChannels: () => {
      const connection = params.connections[opened];

      opened += 1;

      if (!connection) return { refuse: { status: 503, code: 'internal' } };

      return Array.isArray(connection) ? sends(connection) : connection;
    },
  });
  const client = createClient({
    url: 'http://backend.test',
    token: 't',
    fetch,
    // Gives the event loop its turn, and stops after a few attempts: a loop that never ended would
    // otherwise spin on promises alone and hang the test run past any timeout.
    reconnect: {
      wait: () => new Promise((resolve) => setTimeout(resolve, 0)),
      attempts: 6,
      ...params.reconnect,
    },
  });
  const asked = () =>
    calls.map(({ call }: { call: FakeCall }) => subscribeRequestSchema.parse(call.body));

  return { client, asked };
}

type Served = ReturnType<typeof served>;

/** Follows the channels (`[name, from]`) of the conversation to the end, and answers every frame. */
async function followed(params: {
  world: Served;
  channels: [string, string][];
  approvals?: boolean;
  signal?: AbortSignal;
}) {
  const frames = await subscribeChannels({
    client: params.world.client,
    id: ID,
    subscriptions: params.channels.map(([name, from]) => ({ channel: channelOf(name), from })),
    signal: params.signal ?? new AbortController().signal,
    ...(params.approvals !== undefined && { approvals: params.approvals }),
  });
  const seen: SubscribeFrame[] = [];

  for await (const frame of frames) seen.push(frame);

  return seen;
}

/** A frame as a test reads it: its channel, and its type with the cursor. */
const brief = (frame: SubscribeFrame) =>
  `${frame.channel} ${frame.type} ${'cursor' in frame ? frame.cursor : ''}`.trim();

describe('subscribeChannels', () => {
  it('yields the frames of every channel in the order they came, and ends once each channel has ended', async () => {
    const world = served({
      connections: [
        [
          agentOpened('a'),
          outputText({ name: 'cmd', offset: 0, text: 'hi' }),
          agentUpdated({ name: 'a', n: 1 }),
          endedAs({ name: 'a', reason: 'completed' }),
          commandClosed({ name: 'cmd', bytes: 2 }),
          endedAs({ name: 'cmd', reason: 'completed' }),
        ],
      ],
    });

    const seen = await followed({
      world,
      channels: [
        ['a', 'start'],
        ['cmd', 'start'],
      ],
    });

    expect(seen.map(brief)).toEqual([
      'a opened s0',
      'cmd output b2',
      'a updated s1',
      'a end',
      'cmd closed b2',
      'cmd end',
    ]);
    expect(world.asked()).toEqual([
      {
        subscriptions: [
          { channel: 'a', from: 'start' },
          { channel: 'cmd', from: 'start' },
        ],
      },
    ]);
  });

  it('opens again after a drop with the cursor each channel reached, and misses and repeats nothing', async () => {
    const world = served({
      connections: [
        [agentOpened('a'), agentOpened('b'), agentUpdated({ name: 'a', n: 1 }), DROP],
        [
          // The server resumes after the cursors it was given, and may repeat the last frame.
          agentUpdated({ name: 'a', n: 1 }),
          agentUpdated({ name: 'a', n: 2 }),
          agentUpdated({ name: 'b', n: 1 }),
          endedAs({ name: 'a', reason: 'completed' }),
          endedAs({ name: 'b', reason: 'completed' }),
        ],
      ],
    });

    const seen = await followed({
      world,
      channels: A_AND_B,
    });

    expect(seen.map(brief)).toEqual([
      'a opened s0',
      'b opened s0',
      'a updated s1',
      'a updated s2',
      'b updated s1',
      'a end',
      'b end',
    ]);
    expect(world.asked()[1]).toEqual({
      subscriptions: [
        { channel: 'a', from: 's1' },
        { channel: 'b', from: 's0' },
      ],
    });
  });

  it('does not ask again for a channel that ended before the drop, and ends when the others have', async () => {
    const world = served({
      connections: [
        [agentOpened('a'), endedAs({ name: 'a', reason: 'completed' }), agentOpened('b'), DROP],
        [agentUpdated({ name: 'b', n: 1 }), endedAs({ name: 'b', reason: 'completed' })],
      ],
    });

    await followed({
      world,
      channels: A_AND_B,
    });

    expect(world.asked()[1]).toEqual({ subscriptions: [{ channel: 'b', from: 's0' }] });
  });

  it('delivers the closed entry of a command once, though its cursor is that of the output before it', async () => {
    const world = served({
      connections: [
        [outputText({ name: 'cmd', offset: 0, text: 'hi' }), DROP],
        [commandClosed({ name: 'cmd', bytes: 2 }), endedAs({ name: 'cmd', reason: 'completed' })],
      ],
    });

    const seen = await followed({ world, channels: [['cmd', 'start']] });

    expect(seen.map(brief)).toEqual(['cmd output b2', 'cmd closed b2', 'cmd end']);
    expect(world.asked()[1]).toEqual({ subscriptions: [{ channel: 'cmd', from: 'b2' }] });
  });

  it('leaves a connection that cut a channel off, and asks again for that channel from the cursor it was given', async () => {
    const world = served({
      connections: [
        [
          agentOpened('a'),
          agentOpened('b'),
          endedAs({ name: 'a', reason: 'cut_off', cursor: 's0' }),
          // Never read: the client has left this connection.
          agentUpdated({ name: 'b', n: 1 }),
        ],
        [
          agentUpdated({ name: 'a', n: 1 }),
          endedAs({ name: 'a', reason: 'completed' }),
          agentUpdated({ name: 'b', n: 1 }),
          endedAs({ name: 'b', reason: 'completed' }),
        ],
      ],
    });

    const seen = await followed({ world, channels: A_AND_B });

    expect(world.asked()[1]).toEqual({
      subscriptions: [
        { channel: 'a', from: 's0' },
        { channel: 'b', from: 's0' },
      ],
    });
    // The cut is the client's business: the reader sees each frame once.
    expect(seen.map(brief)).toEqual([
      'a opened s0',
      'b opened s0',
      'a updated s1',
      'a end',
      'b updated s1',
      'b end',
    ]);
  });

  it('says it answers approvals on every connection it opens, and not when it does not', async () => {
    const claiming = served({
      connections: [
        [headAt({ name: 'tree', cursor: 's3' }), DROP],
        [endedAs({ name: 'tree', reason: 'completed' })],
      ],
    });

    await followed({ world: claiming, channels: [['tree', 'now']], approvals: true });

    expect(claiming.asked().map(({ approvals }) => approvals)).toEqual([true, true]);
    expect(claiming.asked()[1]).toEqual({
      subscriptions: [{ channel: 'tree', from: 's3' }],
      approvals: true,
    });

    const reading = served({ connections: [[endedAs({ name: 'a', reason: 'completed' })]] });

    await followed({ world: reading, channels: [['a', 'start']] });

    expect(reading.asked()[0]).not.toHaveProperty('approvals');
  });

  it('asks a channel that had no frame yet again as it was first asked', async () => {
    const world = served({
      connections: [[DROP], [endedAs({ name: 'a', reason: 'completed' })]],
    });

    await followed({ world, channels: [['a', 'tail:5']] });

    expect(world.asked()[1]).toEqual({ subscriptions: [{ channel: 'a', from: 'tail:5' }] });
  });
});

describe('subscribeChannels, when it cannot go on', () => {
  it('throws a refusal as it is, and does not ask again: a cursor the server cannot serve is for the caller', async () => {
    const world = served({
      connections: [
        [agentOpened('a'), DROP],
        { refuse: { status: 422, code: 'cursor_out_of_range', message: 'gone' } },
      ],
    });

    await expect(followed({ world, channels: [['a', 'start']] })).rejects.toMatchObject({
      status: 422,
      code: 'cursor_out_of_range',
    });
    expect(world.asked()).toHaveLength(2);
  });

  it('asks again when a reconnect is refused for too many subscriptions, which the server says to', async () => {
    const world = served({
      connections: [
        [agentOpened('a'), DROP],
        { refuse: { status: 429, code: 'too_many_subscriptions' } },
        [agentUpdated({ name: 'a', n: 1 }), endedAs({ name: 'a', reason: 'completed' })],
      ],
    });

    const seen = await followed({ world, channels: [['a', 'start']] });

    expect(seen.map(brief)).toEqual(['a opened s0', 'a updated s1', 'a end']);
    expect(world.asked()).toHaveLength(3);
  });

  it('rejects at once when the server refuses the first connection', async () => {
    const world = served({ connections: [{ refuse: { status: 404, code: 'not_found' } }] });

    await expect(followed({ world, channels: [['a', 'start']] })).rejects.toBeInstanceOf(
      RefusedError,
    );
  });

  it('gives up with StreamLostError after the attempts it may make in a row', async () => {
    const world = served({
      connections: [[agentOpened('a'), DROP]],
      reconnect: { attempts: 2 },
    });

    await expect(followed({ world, channels: [['a', 'start']] })).rejects.toBeInstanceOf(
      StreamLostError,
    );
    // The first connection, then two attempts that the server answered with a 503.
    expect(world.asked()).toHaveLength(3);
  });

  it('counts a channel cut off with nothing delivered as a failed attempt, so it cannot loop for ever', async () => {
    const cut = [endedAs({ name: 'a', reason: 'cut_off' })];
    const world = served({
      connections: [cut, cut, cut, cut, cut, cut],
      reconnect: { attempts: 3 },
    });

    await expect(followed({ world, channels: [['a', 'start']] })).rejects.toBeInstanceOf(
      StreamLostError,
    );
  });

  it('does not ask again for a frame that is off the contract', async () => {
    let requests = 0;
    // A head frame with no cursor: not what the contract says.
    const fetch = () => {
      requests += 1;

      return Promise.resolve(
        new Response('event: head\ndata: {"type":"head","channel":"a"}\n\n', {
          headers: { 'content-type': 'text/event-stream' },
        }),
      );
    };
    const frames = await subscribeChannels({
      client: createClient({ url: 'http://backend.test', token: 't', fetch }),
      id: ID,
      subscriptions: [{ channel: channelOf('a'), from: 'start' }],
      signal: new AbortController().signal,
    });

    await expect(frames.next()).rejects.toBeInstanceOf(ZodError);
    expect(requests).toBe(1);
  });

  it('ends without an error when its signal aborts', async () => {
    const world = served({ connections: [[agentOpened('a')]] });
    const stop = new AbortController();
    const frames = await subscribeChannels({
      client: world.client,
      id: ID,
      subscriptions: [{ channel: channelOf('a'), from: 'start' }],
      signal: stop.signal,
    });

    expect((await frames.next()).value).toMatchObject({ type: 'opened' });
    stop.abort();

    expect(await frames.next()).toEqual({ done: true, value: undefined });
  });
});

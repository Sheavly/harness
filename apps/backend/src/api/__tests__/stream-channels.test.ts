import { afterEach, describe, expect, it, vi } from 'vitest';
import { createClient } from '@sheavly/client/client/client.helper';
import { conversationIdSchema, serverErrorSchema } from '@sheavly/protocol/server/server.validator';
import type { SubscribeFrame } from '@sheavly/protocol/subscription/subscription.types';
import { subscribeFrameSchema } from '@sheavly/protocol/subscription/subscription.validator';
import { readChannel } from '@sheavly/runtime/testing/stored-channels.fake';
import { MemoryConversationStore } from '@sheavly/testing/store/memory-store.fake';
import { reply, testApi } from '../../testing/api.fake.js';
import { useOpenedServers } from '../../testing/opened-servers.fake.js';
import { TEST_TOKEN } from '../../testing/testing.constants.js';

// The route that follows node channels, over a real listener and in-process: what a client reads
// of a conversation's stored channels and of what is stored next, and how a request it cannot have
// is refused. The in-process requests are the same app the listener serves.

const servers = useOpenedServers();

/** A conversation that ran one prompt, kept in a store, served on a real port and in-process. */
async function served(store = new MemoryConversationStore()) {
  const api = testApi({ go: [reply('done')] }, store);
  const url = await servers.listen(api.app.fetch);
  const client = createClient({ url, token: TEST_TOKEN });
  const id = await api.start();

  for await (const _frame of api.runOf({ id, text: 'go' }));

  const conversation = conversationIdSchema.parse(id);

  await api.conversations.get(conversation).harness.nodeChannels?.flush();

  const [channel = ''] = await store.channels(conversation);

  return { api, store, client, id, conversation, channel };
}

/** A request body for one channel from `from`. */
const bodyOf = (channel: string, from: string) => ({ subscriptions: [{ channel, from }] });

/** Asks, in-process, to follow `channel` from now: the response to hold open or to cancel. */
const askNow = (params: {
  api: Awaited<ReturnType<typeof served>>['api'];
  id: string;
  channel: string;
}) =>
  params.api.request(`/conversations/${params.id}/subscribe`, {
    method: 'QUERY',
    body: bodyOf(params.channel, 'now'),
  });

/**
 * The text of each server-sent frame of `body`, as it ends. The client's own reader keeps only the
 * frames of the conversation stream, which have an `id`; these have none, so a test reads them here.
 */
async function* rawFrames(body: ReadableStream<Uint8Array>) {
  const decoder = new TextDecoder();
  let buffered = '';

  for await (const chunk of body) {
    buffered += decoder.decode(chunk, { stream: true });

    for (let end = buffered.indexOf('\n\n'); end !== -1; end = buffered.indexOf('\n\n')) {
      yield buffered.slice(0, end);
      buffered = buffered.slice(end + 2);
    }
  }
}

/** The frames of a stream body, one at a time, as a client reads them. */
function framesOf(body: ReadableStream<Uint8Array>) {
  const frames = rawFrames(body);

  return async (): Promise<{ event: string; frame: SubscribeFrame } | undefined> => {
    for (;;) {
      const next = await frames.next();

      if (next.done) return undefined;

      const lines = next.value.split('\n');
      const event = lines.find((each) => each.startsWith('event: '));
      const data = lines.find((each) => each.startsWith('data: '));

      // A heartbeat comment is neither.
      if (!event || !data) continue;

      const parsed: unknown = JSON.parse(data.slice('data: '.length));

      return { event: event.slice('event: '.length), frame: subscribeFrameSchema.parse(parsed) };
    }
  };
}

describe('following a conversation’s channels over HTTP', () => {
  it('serves what is stored, then what comes, and ends with the channel', async () => {
    const { api, store, client, id, conversation, channel } = await served();
    const stored = await readChannel({ store, id: conversation, channel });
    const next = framesOf(
      await client.open('streamChannels', { id, body: bodyOf(channel, 'start') }),
    );
    const history = [];

    for (const _entry of stored) history.push(await next());

    // The stored history, as entry frames, in the order it was stored.
    expect(history.map((each) => each?.event)).toEqual(stored.map(() => 'entry'));
    expect(history.map((each) => each?.frame)).toMatchObject(
      stored.map((entry) => ({ type: entry.type, cursor: entry.cursor })),
    );

    // The conversation closes: its agent's channel ends with a `closed` entry, and then the stream.
    expect((await api.request(`/conversations/${id}`, { method: 'DELETE' })).status).toBe(204);

    const closed = await next();
    const end = await next();

    expect(closed).toMatchObject({ event: 'entry', frame: { type: 'closed' } });
    expect(end).toMatchObject({
      event: 'end',
      frame: { type: 'end', channel, reason: 'completed', cursor: closed?.frame.cursor },
    });
    expect(await next()).toBeUndefined();
  });

  it('says first where a channel stands when it is asked from now', async () => {
    const { store, client, id, conversation, channel } = await served();
    const stored = await readChannel({ store, id: conversation, channel });
    const next = framesOf(
      await client.open('streamChannels', { id, body: bodyOf(channel, 'now') }),
    );

    expect(await next()).toMatchObject({
      event: 'head',
      frame: { type: 'head', channel, cursor: stored.at(-1)?.cursor },
    });
  });
});

describe('a request the server cannot serve', () => {
  /** What a refused request answers: its status and the protocol's code and message. */
  async function refusal(params: {
    api: Awaited<ReturnType<typeof served>>['api'];
    id: string;
    body: unknown;
  }) {
    const response = await params.api.request(`/conversations/${params.id}/subscribe`, {
      method: 'QUERY',
      body: params.body,
    });

    return { status: response.status, ...serverErrorSchema.parse(await response.json()).error };
  }

  it('is not found, the same for another conversation’s channel, an unknown one and the tree', async () => {
    const { api, store, id, channel } = await served();
    const other = conversationIdSchema.parse(await api.start());

    await api.conversations.get(other).harness.nodeChannels?.flush();

    const [otherChannel = ''] = await store.channels(other);
    const answers = [];

    expect(otherChannel).not.toBe('');

    for (const name of [otherChannel, 'no-such-node', 'tree']) {
      answers.push(await refusal({ api, id, body: bodyOf(name, 'start') }));
    }

    expect(channel).not.toBe('');
    expect(new Set(answers.map((each) => JSON.stringify(each))).size).toBe(1);
    expect(answers[0]).toMatchObject({ status: 404, code: 'not_found' });
  });

  it.each([
    ['a tail over what a numbered channel allows', 'tail:1001', 400, 'bad_request'],
    ['a byte cursor on a numbered channel', 'b3', 400, 'bad_request'],
    ['a cursor the channel does not hold', 's999', 422, 'cursor_out_of_range'],
  ])('refuses %s', async (_name, from, status, code) => {
    const { api, id, channel } = await served();

    expect(await refusal({ api, id, body: bodyOf(channel, from) })).toMatchObject({ status, code });
  });

  it('refuses a body that is not a request, and a conversation that is not there', async () => {
    const { api, id, channel } = await served();

    expect(await refusal({ api, id, body: { subscriptions: [] } })).toMatchObject({
      status: 400,
      code: 'bad_request',
    });
    expect(
      await refusal({
        api,
        id: '00000000-0000-4000-8000-000000000000',
        body: bodyOf(channel, 'now'),
      }),
    ).toMatchObject({ status: 404, code: 'not_found' });
  });

  it('wants the token, as every route does', async () => {
    const { api, id, channel } = await served();
    const response = await api.app.request(`/conversations/${id}/subscribe`, {
      method: 'QUERY',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(bodyOf(channel, 'now')),
    });

    expect(response.status).toBe(401);
  });
});

/** A store whose list of channels waits, once armed, until it is released: the start of a read. */
class GatedChannels extends MemoryConversationStore {
  readonly reached = Promise.withResolvers<undefined>();
  readonly #go = Promise.withResolvers<undefined>();
  #armed = false;

  arm() {
    this.#armed = true;
  }

  release() {
    this.#go.resolve(undefined);
  }

  override async channels(id: Parameters<MemoryConversationStore['channels']>[0]) {
    if (this.#armed) {
      this.reached.resolve(undefined);
      await this.#go.promise;
    }

    return super.channels(id);
  }
}

describe('the subscriptions a conversation holds', () => {
  const LIMIT = 64;
  /** Every response a test holds open, cancelled after it whatever it asserted. */
  const held: Response[] = [];

  afterEach(async () => {
    for (const response of held.splice(0)) await response.body?.cancel();
  });

  it('gives back its place when a client leaves while its history is still being read', async () => {
    const store = new GatedChannels();
    const { api, client, id, channel } = await served(store);
    const open = () => askNow({ api, id, channel });

    // Every place but one held; the last asked for over a real connection, which then leaves.
    for (let count = 0; count < LIMIT - 1; count += 1) held.push(await open());

    store.arm();

    const leaving = new AbortController();
    const opening = client.open('streamChannels', {
      id,
      body: bodyOf(channel, 'now'),
      signal: leaving.signal,
    });

    // What the aborted request ends with, kept so it is checked and never left unhandled.
    const outcome = opening.then(
      () => undefined,
      (caughtError: unknown) => caughtError,
    );

    await store.reached.promise;
    leaving.abort();
    // The server notices the socket close while the read is still waiting, and only then goes on.
    await new Promise((resolve) => setTimeout(resolve, 150));
    store.release();

    // Its place is free again: without it the conversation would answer 429 for good.
    await vi.waitFor(
      async () => {
        const admitted = await open();

        held.push(admitted);

        expect(admitted.status).toBe(200);
      },
      { timeout: 5000 },
    );
    expect(await outcome).toBeInstanceOf(Error);
  });

  it('are bounded, and a client that leaves gives its place back', async () => {
    const { api, client, id, channel } = await served();
    const open = () => askNow({ api, id, channel });

    // Every place but one, held in-process; the last, over a real connection.
    for (let count = 0; count < LIMIT - 1; count += 1) held.push(await open());

    const leaving = new AbortController();
    const last = framesOf(
      await client.open('streamChannels', {
        id,
        body: bodyOf(channel, 'now'),
        signal: leaving.signal,
      }),
    );

    // Its first frame says it is open, and so it holds its place.
    expect((await last())?.event).toBe('head');

    const full = await open();

    expect(full.status).toBe(429);
    expect(serverErrorSchema.parse(await full.json()).error.code).toBe('too_many_subscriptions');

    // The client goes away: the server sees the connection close, and the place is free again.
    leaving.abort();

    await vi.waitFor(async () => {
      const admitted = await open();

      held.push(admitted);

      expect(admitted.status).toBe(200);
    });
  });
});

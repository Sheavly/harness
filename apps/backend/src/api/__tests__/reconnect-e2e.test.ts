import { serve } from '@hono/node-server';
import net from 'node:net';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { watchApprovals } from '@sheavly/client/approvals/approvals.helper';
import { createClient } from '@sheavly/client/client/client.helper';
import { readEntries } from '@sheavly/client/client/entries.helper';
import { reconnectingEntries } from '@sheavly/client/client/reconnect.helper';
import { promptEntries } from '@sheavly/client/prompt/prompt.helper';
import { conversationIdSchema } from '@sheavly/protocol/server/server.validator';
import type { StreamEntry } from '@sheavly/protocol/stream/stream.types';
import { toolCall } from '@sheavly/testing/provider/routed-provider.fake';
import { MemoryConversationStore } from '@sheavly/testing/store/memory-store.fake';
import { reply, testApi } from '../../testing/api.fake.js';
import { TEST_TOKEN } from '../../testing/testing.constants.js';
import { SSE_QUEUE_LIMIT } from '../api.constants.js';

// End to end, over real sockets: a real HTTP server, a proxy that cuts the connections, and the
// client UIs use. The in-process tests cover each piece; these cover them together.

const asks = () => [
  toolCall({ id: 'c1', name: 'ask', input: {} }),
  { type: 'done' as const, stopReason: 'tool_use' as const },
];

/**
 * The two updates one approval makes, in order, with the id the registry issued: its ids are
 * random, so the test reads it from the request it heard. Empty when none was heard, so a missing
 * or repeated update fails the comparison.
 */
function askedThenResolved(heard: readonly string[]): string[] {
  const [asked] = heard;
  const id = asked?.startsWith('approval_requested:')
    ? asked.slice('approval_requested:'.length)
    : '';

  return id === '' ? [] : [`approval_requested:${id}`, `approval_resolved:${id}`];
}

/** A TCP proxy to `port` that can cut every connection through it, as a flaky network does. */
async function proxyTo(port: number) {
  const sockets = new Set<net.Socket>();
  let connections = 0;
  const server = net.createServer((client) => {
    const upstream = net.connect(port, '127.0.0.1');
    const drop = () => {
      client.destroy();
      upstream.destroy();
      sockets.delete(client);
      sockets.delete(upstream);
    };

    connections += 1;
    sockets.add(client);
    sockets.add(upstream);
    client.pipe(upstream);
    upstream.pipe(client);
    for (const socket of [client, upstream]) socket.on('error', drop).on('close', drop);
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));

  return {
    url: `http://127.0.0.1:${String((server.address() as AddressInfo).port)}`,
    connections: () => connections,
    sever: () => {
      for (const socket of sockets) socket.destroy();
    },
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

describe('a client over a connection that drops', () => {
  const cleanups: (() => Promise<void>)[] = [];

  afterEach(async () => {
    for (const cleanup of cleanups.splice(0)) await cleanup();
  });

  /** Serves a test API on a real port, and gives its address, port and conversations. */
  async function listen(api: ReturnType<typeof testApi>) {
    const server = await new Promise<ReturnType<typeof serve>>((resolve) => {
      const started = serve({ fetch: api.app.fetch, hostname: '127.0.0.1', port: 0 }, () =>
        resolve(started),
      );
    });
    const port = (server.address() as AddressInfo).port;

    cleanups.push(async () => {
      await api.conversations.closeAll();
      if ('closeAllConnections' in server) server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    });

    return { url: `http://127.0.0.1:${String(port)}`, port, ...api };
  }

  /**
   * A conversation behind the proxy, followed through `reconnectingEntries` as the terminal follows
   * its live stream: endless, reopened after the last entry. `wait` is the pause between attempts.
   */
  async function followedConversation(params: { wait: () => Promise<void> }) {
    const api = await listen(testApi({}));
    const proxy = await proxyTo(api.port);

    cleanups.push(proxy.close);

    const client = createClient({ url: proxy.url, token: TEST_TOKEN });
    const { id } = await client.call('startConversation', { body: {} });
    const { sessions, mainSession } = api.conversations.get(conversationIdSchema.parse(id)).harness;
    const stop = new AbortController();
    const got: StreamEntry[] = [];
    // Resolves when the first bytes of a stream (its head frame) have reached the client, so a test
    // cuts the network only after that, not after a guess at how long it takes.
    const arrived = Promise.withResolvers<undefined>();
    const following = (async () => {
      for await (const entry of reconnectingEntries({
        endless: true,
        signal: stop.signal,
        wait: params.wait,
        open: async ({ lastEventId }) => {
          const body = await client.open('streamConversation', {
            id,
            body: {},
            signal: stop.signal,
            ...(lastEventId !== undefined && { lastEventId }),
          });

          return body.pipeThrough(
            new TransformStream<Uint8Array, Uint8Array>({
              transform(chunk, controller) {
                arrived.resolve(undefined);
                controller.enqueue(chunk);
              },
            }),
          );
        },
      })) {
        got.push(entry);
      }
    })();
    const publishOne = (text: string) =>
      sessions.publish({ sessionId: mainSession.id, event: { seq: 0, type: 'text_delta', text } });

    return { proxy, sessions, publishOne, stop, following, got, arrived: arrived.promise };
  }

  /**
   * A conversation that asks for approval, watched through the proxy by a UI that answers (by the
   * direct route, so an answer does not depend on the watched connection). `cutWhenAsked` drops the
   * network right after the request is heard.
   */
  async function watchedConversation(params: { cutWhenAsked: boolean; fastReconnect?: boolean }) {
    const api = await listen(testApi({ go: [asks, reply('done')] }));
    const proxy = await proxyTo(api.port);

    cleanups.push(proxy.close);

    const viaProxy = createClient({
      url: proxy.url,
      token: TEST_TOKEN,
      ...(params.fastReconnect && {
        reconnect: { wait: () => new Promise((resolve) => setTimeout(resolve, 50)) },
      }),
    });
    const direct = createClient({ url: api.url, token: TEST_TOKEN });
    const { id } = await direct.call('startConversation', { body: {} });
    const heard: string[] = [];
    const stop = new AbortController();
    const { ended } = await watchApprovals({
      client: viaProxy,
      id,
      signal: stop.signal,
      onApproval: ({ update }) => {
        const approval = update.type === 'approval_requested' ? update.request.id : update.id;

        heard.push(`${update.type}:${approval}`);

        if (update.type !== 'approval_requested') return;

        if (params.cutWhenAsked) proxy.sever();
        void direct.send('answerApproval', {
          id,
          approval,
          body: { response: { decision: 'approve' } },
        });
      },
    });

    /** Runs the prompt to its end, then waits until the watcher has heard the answer. */
    const run = async () => {
      for await (const _entry of promptEntries({ client: direct, id, prompt: { text: 'go' } }));

      await vi.waitFor(() => {
        expect(heard.some((each) => each.startsWith('approval_resolved:'))).toBe(true);
      });
      stop.abort();
      await ended;
    };

    const { approvals } = api.conversations.get(conversationIdSchema.parse(id)).harness;

    return { proxy, direct, id, heard, run, approvals };
  }

  it('keeps answering approvals after the connection is cut, and hears each update once', async () => {
    const { proxy, direct, id, heard, run } = await watchedConversation({ cutWhenAsked: true });

    await run();

    // Each update once, in order, although the stream was cut between the two.
    expect(heard).toEqual(askedThenResolved(heard));
    expect(proxy.connections()).toBeGreaterThanOrEqual(2);

    const history = await direct.call('getMessages', { id });

    expect(JSON.stringify(history.messages)).toContain('done');
  });

  it('listens for approvals again once reconnected, so one asked afterwards is answered', async () => {
    const { proxy, heard, run, approvals } = await watchedConversation({
      cutWhenAsked: false,
      fastReconnect: true,
    });
    const before = proxy.connections();

    // Cut, and wait until the watcher is back on a new connection, listening, before the prompt runs.
    proxy.sever();
    await vi.waitFor(() => {
      expect(proxy.connections()).toBeGreaterThan(before);
      expect(approvals.listening).toBe(true);
    });

    await run();

    expect(heard).toEqual(askedThenResolved(heard));
  });

  it('cuts a consumer that does not read, and a client that resumes gets every entry once', async () => {
    const api = await listen(testApi({}, new MemoryConversationStore()));
    const client = createClient({ url: api.url, token: TEST_TOKEN });
    const { id } = await client.call('startConversation', { body: {} });
    const { sessions, mainSession } = api.conversations.get(conversationIdSchema.parse(id)).harness;
    const made: number[] = [];

    sessions.subscribeEntries((entry) => made.push(entry.seq));

    // The stream is opened and left unread, so the socket's buffers fill and entries queue up.
    const unread = await client.open('streamConversation', { id, body: {} });
    const text = 'x'.repeat(32_000);

    for (let i = 0; i < SSE_QUEUE_LIMIT + 300; i++) {
      sessions.publish({
        sessionId: mainSession.id,
        event: { seq: i, type: 'text_delta', text },
      });
      // Lets the server write, so the socket's own buffer is what fills.
      if (i % 50 === 0) await new Promise((resolve) => setImmediate(resolve));
    }

    // Now the client reads what the server kept for it. The stream has no end of its own, so one
    // that ends before the last entry was cut: that is the slow-consumer policy at work.
    const lastSeq = made.at(-1) ?? 0;
    const first: number[] = [];

    for await (const { entry } of readEntries(unread)) {
      first.push(entry.seq);
      if (entry.seq === lastSeq) break;
    }

    expect(first.at(-1) ?? -1).toBeLessThan(lastSeq);

    // It resumes after the last entry it got (or from the start, if it got none), and the two
    // reads together are everything the conversation made, once each and in order.
    const resumed = await client.open('streamConversation', {
      id,
      body: { replay: true },
      ...(first.length > 0 && { lastEventId: first.at(-1) ?? 0 }),
    });
    const rest: number[] = [];

    for await (const { entry } of readEntries(resumed)) {
      rest.push(entry.seq);
      if (entry.seq === lastSeq) break;
    }

    expect([...first, ...rest].filter((seq) => seq >= (made[0] ?? 0))).toEqual(made);
  }, 60_000);

  it('follows a conversation through reconnectingEntries across a cut, each entry once', async () => {
    const { proxy, sessions, publishOne, stop, following, got } = await followedConversation({
      wait: () => new Promise((resolve) => setTimeout(resolve, 20)),
    });
    const made: number[] = [];

    sessions.subscribeEntries((entry) => made.push(entry.seq));

    const publish = (count: number) => {
      for (let i = 0; i < count; i++) publishOne('x');
    };

    // Entries are made until the stream is open and the first one reaches it.
    await vi.waitFor(() => {
      publish(1);
      expect(got.length).toBeGreaterThan(0);
    });
    await vi.waitFor(() => {
      expect(got.at(-1)?.seq).toBe(made.at(-1));
    });

    // Cut while it is following, make more while it is down, and wait for it to catch up.
    const connections = proxy.connections();

    proxy.sever();
    publish(5);
    await vi.waitFor(() => {
      expect(got.at(-1)?.seq).toBe(made.at(-1));
    });
    stop.abort();
    await following;

    expect(proxy.connections()).toBeGreaterThan(connections);
    // Everything from the first entry it got, once each and in order, across the cut.
    const seqs = got.map((entry) => entry.seq);

    expect(seqs).toEqual(made.slice(made.indexOf(seqs[0] ?? 0)));
  }, 30_000);

  it('misses nothing made while it was down, even when it had received no entry yet', async () => {
    const outage = Promise.withResolvers<undefined>();
    const { proxy, publishOne, stop, following, got, arrived } = await followedConversation({
      wait: () => outage.promise,
    });
    const texts = () =>
      got.flatMap((entry) =>
        entry.kind === 'event' && entry.event.type === 'text_delta' ? [entry.event.text] : [],
      );

    // The stream is open and has delivered no entry, only its head frame; the network drops.
    await arrived;
    proxy.sever();
    publishOne('while down');
    outage.resolve(undefined);
    await vi.waitFor(() => {
      publishOne('after');
      expect(texts()).toContain('after');
    });
    stop.abort();
    await following;

    // The stream's head frame gave an id to resume after, although no entry had arrived, so what
    // was made in between is delivered: once, and before what came after.
    expect(texts().filter((text) => text !== 'after')).toEqual(['while down']);
    expect(texts().indexOf('while down')).toBeLessThan(texts().indexOf('after'));
  }, 30_000);

  it('cuts a stream whose reader falls behind before the run’s done, and the rest is there on resume', async () => {
    const huge = Array.from({ length: SSE_QUEUE_LIMIT + 200 }, () => ({
      type: 'text_delta' as const,
      text: 'x'.repeat(32_000),
    }));
    const big = () => [...huge, { type: 'done' as const, stopReason: 'end_turn' as const }];
    const api = await listen(testApi({ big: [big] }, new MemoryConversationStore()));
    const client = createClient({ url: api.url, token: TEST_TOKEN });
    const { id } = await client.call('startConversation', { body: {} });

    // The stream is opened and left unread while the run makes about 40 MB of entries.
    const response = await client.open('streamConversation', { id, body: {} });

    await client.call('sendPrompt', { id, body: { text: 'big' } });

    await vi.waitFor(
      async () => {
        const { messages } = await client.call('getMessages', { id });

        expect(messages.length).toBeGreaterThanOrEqual(2);
      },
      { timeout: 30_000 },
    );

    const response_seqs: number[] = [];
    let sawDone = false;

    for await (const { entry } of readEntries(response)) {
      response_seqs.push(entry.seq);
      sawDone ||= entry.kind === 'event' && entry.event.type === 'done';
    }

    // The prompt ran to its end, but this stream was cut before it: no done in it.
    expect(sawDone).toBe(false);

    // The rest of the conversation is on its stream, after the last entry the response gave.
    const rest = await client.open('streamConversation', {
      id,
      body: { replay: true },
      ...(response_seqs.length > 0 && { lastEventId: response_seqs.at(-1) ?? 0 }),
    });
    const restSeqs: number[] = [];

    for await (const { entry } of readEntries(rest)) {
      restSeqs.push(entry.seq);
      if (entry.kind === 'event' && entry.event.type === 'done') break;
    }

    const all = [...response_seqs, ...restSeqs];

    expect(all.slice(1).every((seq, index) => seq === (all[index] ?? 0) + 1)).toBe(true);
  }, 90_000);
});

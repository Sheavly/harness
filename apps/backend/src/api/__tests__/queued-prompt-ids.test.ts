import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { followConversation } from '@sheavly/client/client/follow.helper';
import { followNode } from '@sheavly/client/nodes/follow-node.helper';
import type { NodeChannelEntry } from '@sheavly/client/nodes/nodes.types';
import { watchTree } from '@sheavly/client/tree/watch-tree.helper';
import type { MessageId } from '@sheavly/protocol/message/message.types';
import { conversationIdSchema } from '@sheavly/protocol/server/server.validator';
import type { StreamEntry } from '@sheavly/protocol/stream/stream.types';
import type { TreeChannelEntry } from '@sheavly/protocol/tree/tree.types';
import { fakeFetch } from '@sheavly/testing/fetch/fake-fetch.fake';
import { until } from '@sheavly/testing/wait/until.fake';
import { testBackend } from '../../testing/backend.fake.js';
import { seedFakeModel } from '../../testing/seed-model.fake.js';
import { untilSettled } from '../../testing/settled.fake.js';

// A real backend and the real loop: a prompt sent while a run goes waits in the queue, and the id
// its answer gave is the one every channel names for it when it starts, is refused or is replaced
// away, read through the client over the real routes.

/** A model whose first call waits for `release()`, and that answers every later one at once. */
function gatedModel() {
  const gate = Promise.withResolvers<undefined>();
  let calls = 0;
  const fetch: typeof globalThis.fetch = async (input, init) => {
    calls += 1;

    if (calls === 1) await gate.promise;

    return fakeFetch([
      { type: 'response.output_text.delta', delta: `answer ${String(calls)}` },
    ]).fetch(input, init);
  };

  return { fetch, release: () => gate.resolve(undefined), calls: () => calls };
}

/** Reads `source` into `into` until it ends, which aborting its signal makes it do. */
async function drain<Item>(params: { source: AsyncIterable<Item>; into: Item[] }) {
  for await (const item of params.source) params.into.push(item);
}

/**
 * A conversation whose first prompt runs (held at its model call), with `second`, `third` and
 * `fourth` queued behind it, the `third` replaced away by a client, and then released: the lines
 * start in order. Every channel is followed from before the first send. `close` removes it all.
 */
async function queuedBehindARun() {
  const base = await mkdtemp(path.join(tmpdir(), 'queued-ids-'));
  const workspace = path.join(base, 'project');
  const model = gatedModel();

  await mkdir(workspace);

  const backend = testBackend({ home: path.join(base, 'home'), workspace, fetch: model.fetch });
  const close = async () => {
    model.release();
    await backend.conversations.closeAll();
    await rm(base, { recursive: true, force: true });
  };

  try {
    await seedFakeModel(backend);

    const { client } = backend;
    const id = conversationIdSchema.parse(
      (await client.call('startConversation', { body: {} })).id,
    );
    const stop = new AbortController();
    const tree: TreeChannelEntry[] = [];
    const stream: StreamEntry[] = [];
    const main: NodeChannelEntry[] = [];
    const watched = await watchTree({
      client,
      id,
      onChange: () => undefined,
      onEntry: ({ entry }) => tree.push(entry),
      signal: stop.signal,
    });

    // Not awaited at the end: the in-process transport leaves a read of the endless conversation
    // stream pending after its abort, which the other tests that follow it leave as well.
    void drain({
      source: await followConversation({ client, id, body: {}, signal: stop.signal }),
      into: stream,
    });
    const mainNode = (await client.call('getTree', { id })).nodes.find(
      (node) => node.kind === 'agent' && node.parent === undefined,
    );

    if (!mainNode) throw new Error('the conversation has no main agent');

    const channel = drain({
      source: await followNode({ client, id, node: mainNode.id, signal: stop.signal }),
      into: main,
    });
    const send = (text: string) => client.call('sendPrompt', { id, body: { text } });
    const first = await send('first');

    await until(() => model.calls() === 1);

    const second = await send('second');
    const third = await send('third');
    const fourth = await send('fourth');

    await client.send('setQueue', { id, body: { queued: ['second', 'fourth'] } });
    model.release();
    await until(
      () => main.filter((e) => e.type === 'event' && e.event.type === 'done').length === 3,
    );
    // The stream's and the tree's readers are separate connections that may be behind the main
    // channel's: they are waited for as well, so what is asserted on them is all of it.
    await until(
      () =>
        stream.filter((entry) => entry.kind === 'event' && entry.event.type === 'done').length ===
        3,
    );
    await until(() => tree.filter((entry) => entry.type === 'prompt_started').length === 3);
    await untilSettled(backend.conversations.get(id));
    stop.abort();
    await Promise.all([watched.ended, channel]);

    return { first, second, third, fourth, tree, stream, main, close };
  } catch (caughtError) {
    await close();
    throw caughtError;
  }
}

type Scenario = Awaited<ReturnType<typeof queuedBehindARun>>;

/** The runs the main agent's channel says started, as `text` and message id. */
const runStartsOf = (main: NodeChannelEntry[]) =>
  main.flatMap((entry) =>
    entry.type === 'run_started' ? [[entry.text, entry.messageId] as const] : [],
  );

/** The ids a `queue_changed` dropped; none for any other entry. */
const droppedBy = (entry: { type: string; dropped?: MessageId[] }) =>
  entry.type === 'queue_changed' ? (entry.dropped ?? []) : [];

/** The types of the loop events of `entries` that answer message `messageId`. */
const eventsOf = (params: { stream: StreamEntry[]; messageId: MessageId }) =>
  params.stream.flatMap((entry) =>
    entry.kind === 'event' && entry.messageId === params.messageId ? [entry.event.type] : [],
  );

describe('a prompt queued behind a run, over the real routes', () => {
  let world: Scenario;

  beforeAll(async () => {
    world = await queuedBehindARun();
  }, 30_000);

  afterAll(async () => {
    await world.close();
  });

  it('is answered as queued with a message id apart from the prompt that runs', () => {
    const { first, second, third, fourth } = world;

    expect(first.status).toBe('started');
    expect(second.status).toBe('queued');
    expect(second.node).toBe(first.node);
    expect(new Set([first, second, third, fourth].map((sent) => sent.messageId)).size).toBe(4);
  });

  it('starts with that same id on the tree’s prompt_started, the stream’s, the main channel’s run_started and the run’s events', () => {
    const { first, second, fourth, tree, stream, main } = world;
    const started = [
      { text: 'first', messageId: first.messageId },
      { text: 'second', messageId: second.messageId },
      { text: 'fourth', messageId: fourth.messageId },
    ];

    expect(tree.filter((entry) => entry.type === 'prompt_started')).toMatchObject(started);
    expect(
      stream.flatMap((entry) =>
        entry.kind === 'queue' && entry.update.type === 'prompt_started' ? [entry.update] : [],
      ),
    ).toMatchObject(started);
    expect(runStartsOf(main)).toEqual(started.map(({ text, messageId }) => [text, messageId]));

    for (const { messageId } of started) {
      expect(eventsOf({ stream, messageId })).toContain('done');
    }
  });

  it('reports the line the client replaced away as dropped, on the tree and the stream, and never starts it', () => {
    const { third, tree, stream } = world;

    expect(tree.flatMap(droppedBy)).toEqual([third.messageId]);
    expect(
      stream.flatMap((entry) => (entry.kind === 'queue' ? droppedBy(entry.update) : [])),
    ).toEqual([third.messageId]);
    expect(eventsOf({ stream, messageId: third.messageId })).toEqual([]);
    expect(runStartsOf(world.main).map(([text]) => text)).not.toContain('third');
  });
});

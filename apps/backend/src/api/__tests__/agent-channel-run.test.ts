import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createClient } from '@sheavly/client/client/client.helper';
import { followNode } from '@sheavly/client/nodes/follow-node.helper';
import type { NodeChannelEntry } from '@sheavly/client/nodes/nodes.types';
import { promptEntries } from '@sheavly/client/prompt/prompt.helper';
import type { NodeId } from '@sheavly/protocol/node/node.types';
import type { ConversationId } from '@sheavly/protocol/server/server.types';
import { conversationIdSchema } from '@sheavly/protocol/server/server.validator';
import type { StreamEntry } from '@sheavly/protocol/stream/stream.types';
import { fakeFetch } from '@sheavly/testing/fetch/fake-fetch.fake';
import { until } from '@sheavly/testing/wait/until.fake';
import { testBackend } from '../../testing/backend.fake.js';
import { cuttingFetch } from '../../testing/cutting-fetch.fake.js';
import { modelRequest } from '../../testing/model-request.fake.js';
import { seedFakeModel } from '../../testing/seed-model.fake.js';
import { untilSettled } from '../../testing/settled.fake.js';
import { TEST_TOKEN } from '../../testing/testing.constants.js';

// A conversation that runs a prompt in which the main agent starts a sub-agent, on the real
// backend and the real loop, read from its agents' channels through the client over the real
// routes: what a client that follows one node needs to show its run, and what it costs.

const FIRST = 'Inspect the project';
const CHILD_TASK = 'READER_TASK';

const opened: { base: string; close: () => Promise<void> }[] = [];

afterEach(async () => {
  for (const { base, close } of opened.splice(0)) {
    await close();
    await rm(base, { recursive: true, force: true });
  }
});

const text = (delta: string) => ({ type: 'response.output_text.delta', delta });
const call = (params: { id: string; name: string; input: object }) => ({
  type: 'response.output_item.done',
  item: {
    type: 'function_call',
    call_id: params.id,
    name: params.name,
    arguments: JSON.stringify(params.input),
  },
});
const usage = {
  type: 'response.completed',
  response: { usage: { input_tokens: 100, output_tokens: 20 } },
};

/**
 * The model: the first prompt makes the main agent say a few words (three deltas) and start a
 * sub-agent; the sub-agent waits for `release`, then reports its status and says it is done; what
 * follows for the main agent (the report that wakes it) is answered in a few words. The sub-agent
 * waiting is what makes the main agent's first run end before the report, so the run the report
 * wakes is a second one, whatever the timing.
 */
function scriptedModel(release: Promise<undefined>): typeof globalThis.fetch {
  let childCalls = 0;
  let mainCalls = 0;

  return async (input, init) => {
    const { task } = await modelRequest(input, init);

    if (task === CHILD_TASK) {
      await release;
      childCalls += 1;

      return fakeFetch(
        childCalls === 1
          ? [call({ id: 'r1', name: 'report_status', input: { status: 'reading' } }), usage]
          : [text('Child finished.'), usage],
      ).fetch(input, init);
    }

    mainCalls += 1;

    return fakeFetch(
      mainCalls === 1
        ? [
            text('Reading '),
            text('the '),
            text('notes. '),
            call({
              id: 'a1',
              name: 'start_agent',
              input: { description: 'Start a reader', title: 'Reader', task: CHILD_TASK },
            }),
            usage,
          ]
        : [text(`Main turn ${String(mainCalls)}.`), usage],
    ).fetch(input, init);
  };
}

/**
 * A real backend over a folder made for the test, with the scripted model as its network. Closing
 * it releases the sub-agent first: a test that failed before it did would otherwise leave the
 * sub-agent waiting, and the close would wait for it.
 */
async function openBackend(gate: PromiseWithResolvers<undefined>) {
  const base = await mkdtemp(path.join(tmpdir(), 'agent-channel-run-'));

  await mkdir(path.join(base, 'project'));

  const backend = testBackend({
    home: path.join(base, 'home'),
    workspace: path.join(base, 'project'),
    fetch: scriptedModel(gate.promise),
  });

  opened.push({
    base,
    close: () => {
      gate.resolve(undefined);

      return backend.conversations.closeAll();
    },
  });
  await seedFakeModel(backend);

  return backend;
}

type OpenBackend = Awaited<ReturnType<typeof openBackend>>;

/** Sends `prompt` to conversation `id` and reads the main agent's stream entries until its run ends. */
async function sentPrompt(params: { backend: OpenBackend; id: ConversationId; prompt: string }) {
  const entries: StreamEntry[] = [];

  for await (const entry of promptEntries({
    client: params.backend.client,
    id: params.id,
    prompt: { text: params.prompt },
  })) {
    entries.push(entry);
  }

  return entries;
}

/**
 * A conversation whose first prompt has run to its end: the main agent said its words and started
 * a sub-agent, which waits for `release()`. The report that comes after it wakes a second run.
 */
async function startedRun() {
  const gate = Promise.withResolvers<undefined>();
  const backend = await openBackend(gate);
  const id = conversationIdSchema.parse(
    (await backend.client.call('startConversation', { body: {} })).id,
  );
  const stream = await sentPrompt({ backend, id, prompt: FIRST });
  const tree = await backend.client.call('getTree', { id });
  const main = tree.nodes.find((node) => node.kind === 'agent' && node.parent === undefined);
  const child = tree.nodes.find((node) => node.kind === 'agent' && node.parent !== undefined);

  if (!main || !child) throw new Error('the conversation has no main agent and sub-agent');

  return {
    backend,
    id,
    stream,
    main: main.id,
    child: child.id,
    release: () => gate.resolve(undefined),
  };
}

/** `startedRun`, with the sub-agent released and everything it started settled and stored. */
async function ranFirst() {
  const run = await startedRun();
  const live = run.backend.conversations.get(run.id);

  run.release();
  await untilSettled(live);
  await live.harness.nodeChannels?.flush();

  return run;
}

/** The `done` events among `entries`. */
const dones = (entries: NodeChannelEntry[]) =>
  entries.filter((entry) => entry.type === 'event' && entry.event.type === 'done');

/** The text of the `text_delta` entries among `entries`, in order. */
const textOf = (entries: NodeChannelEntry[]) =>
  entries.flatMap((entry) =>
    entry.type === 'event' && entry.event.type === 'text_delta' ? [entry.event.text] : [],
  );

/**
 * Follows `node`'s channel from the start through `client`, and answers its entries once it has
 * read `stopAfter` `done` events (the channel of a node that closes ends by itself).
 */
async function followed(params: {
  client: OpenBackend['client'];
  id: ConversationId;
  node: NodeId;
  stopAfter?: number;
}) {
  const stop = new AbortController();
  const entries = await followNode({
    client: params.client,
    id: params.id,
    node: params.node,
    signal: stop.signal,
  });
  const seen: NodeChannelEntry[] = [];

  for await (const entry of entries) {
    seen.push(entry);

    if (params.stopAfter !== undefined && dones(seen).length >= params.stopAfter) stop.abort();
  }

  return seen;
}

/** An entry as `type cursor`, or `event cursor eventType` for an agent's loop event. */
const tag = (entry: NodeChannelEntry) =>
  entry.type === 'event'
    ? `event ${entry.cursor} ${entry.event.type}`
    : `${entry.type} ${entry.cursor}`;

describe('the main agent’s channel, read from its start over the routes', () => {
  it('holds the whole run, in the order it happened, with the sub-agent it started and the run its report woke', async () => {
    const { backend, id, main, child } = await ranFirst();
    const seen = await followed({ client: backend.client, id, node: main, stopAfter: 2 });
    const events = seen.flatMap((entry) => (entry.type === 'event' ? [entry.event] : []));
    const types = events.map((event) => event.type);

    expect(seen[0]).toMatchObject({ type: 'opened', cursor: 's0' });
    // One numbering for the node's changes and its events, with no gap.
    expect(seen.map((entry) => entry.cursor)).toEqual(seen.map((_entry, at) => `s${String(at)}`));
    // The first run: its text, the sub-agent started in place of a result (and which node it is),
    // the usage, the end of the turn and of the run.
    expect(types.slice(0, types.indexOf('done') + 1)).toEqual(
      expect.arrayContaining([
        'text_delta',
        'tool_call_started',
        'task_running',
        'usage',
        'turn_end',
      ]),
    );
    expect(types.indexOf('text_delta')).toBeLessThan(types.indexOf('tool_call_started'));
    expect(types.indexOf('turn_end')).toBeLessThan(types.indexOf('done'));
    expect(events.find((event) => event.type === 'task_running')).toMatchObject({ nodeId: child });
    // The sub-agent was released after the first run ended: its report is told to the model after
    // that run, in a second one.
    expect(types.indexOf('task_completed')).toBeGreaterThan(types.indexOf('done'));
    expect(dones(seen).map((entry) => (entry.type === 'event' ? entry.event : undefined))).toEqual([
      expect.objectContaining({ type: 'done', reason: 'completed' }),
      expect.objectContaining({ type: 'done', reason: 'completed' }),
    ]);
  });

  it('stores the three deltas of a few words as one entry, with the seq of the last one', async () => {
    const { backend, id, main } = await ranFirst();
    const seen = await followed({ client: backend.client, id, node: main, stopAfter: 2 });
    const first = seen.find((entry) => entry.type === 'event' && entry.event.type === 'text_delta');

    expect(first).toMatchObject({
      event: { type: 'text_delta', text: 'Reading the notes. ' },
      lastSeq: expect.any(Number) as number,
    });
    expect(first?.type === 'event' && first.lastSeq).toBe(
      first?.type === 'event' ? first.event.seq + 2 : -1,
    );
  });

  it('gives every event of both runs the message the conversation was started by', async () => {
    const { backend, id, main } = await ranFirst();
    const seen = await followed({ client: backend.client, id, node: main, stopAfter: 2 });
    const events = seen.filter((entry) => entry.type === 'event');
    const ids = new Set(events.map((entry) => entry.messageId));

    expect(events.length).toBeGreaterThan(2);
    // The run the sub-agent's report woke answers the same message as the prompt's run: the
    // originating one, not a new one. Every event has it.
    expect(ids.size).toBe(1);
    expect([...ids][0]).toEqual(expect.any(String));
  });
});

describe('a sub-agent’s own channel', () => {
  it('holds its run and not its parent’s, and ends with the run’s end and then its close', async () => {
    const { backend, id, main, child } = await ranFirst();
    const own = await followed({ client: backend.client, id, node: child });
    const parent = await followed({ client: backend.client, id, node: main, stopAfter: 2 });
    const types = own.flatMap((entry) => (entry.type === 'event' ? [entry.event.type] : []));

    expect(own[0]).toMatchObject({ type: 'opened', cursor: 's0' });
    expect(textOf(own).join('')).toBe('Child finished.');
    expect(textOf(parent).join('')).not.toContain('Child finished.');
    // It reported its status with a tool, and the call and its result are on its channel.
    expect(types).toEqual(expect.arrayContaining(['tool_call_started', 'tool_result', 'usage']));
    // The loop ends a sub-agent's session just before it sends the run's `done`: the channel holds
    // both, the run's end first and the close after.
    expect(own.slice(-2).map(tag)).toEqual([
      expect.stringMatching(/^event s\d+ done$/),
      expect.stringMatching(/^closed s\d+$/),
    ]);
    expect(own.at(-1)).toMatchObject({ type: 'closed', state: 'completed' });
  });
});

describe('following the main agent’s channel while a connection is cut', () => {
  it('misses nothing and repeats nothing when the connection is cut before a whole run, and reads what a client that connects now reads', async () => {
    const { backend, id, main, release } = await startedRun();
    const network = cuttingFetch(async (input, init) =>
      backend.app.request(new Request(input, init)),
    );
    const client = createClient({
      url: 'http://backend.test',
      token: TEST_TOKEN,
      fetch: network.fetch,
      reconnect: { wait: () => new Promise((resolve) => setTimeout(resolve, 0)) },
    });
    const stop = new AbortController();
    const entries = await followNode({ client, id, node: main, signal: stop.signal });
    const seen: NodeChannelEntry[] = [];
    const reading = (async () => {
      for await (const entry of entries) {
        seen.push(entry);

        if (dones(seen).length >= 2) stop.abort();
      }
    })();

    // It has read the first run; the connection is cut, and only then the sub-agent is released:
    // the run its report wakes comes after the cut, and the client reads it live once reconnected,
    // or from the stored channel if the run ended first: both are the same read.
    await until(() => dones(seen).length === 1);
    network.cut();
    release();
    await reading;

    const fresh = await followed({ client: backend.client, id, node: main, stopAfter: 2 });

    expect(dones(seen)).toHaveLength(2);
    expect(seen.map(tag)).toEqual(fresh.map(tag));
    expect(new Set(seen.map(({ cursor }) => cursor)).size).toBe(seen.length);
    expect(network.opened()).toBeGreaterThanOrEqual(2);
  });
});

describe('what a run costs on its channel', () => {
  it('is no more than a quarter above the stream the same run takes, and has fewer entries for the streamed text', async () => {
    const { backend, id, main, stream } = await ranFirst();
    const seen = await followed({ client: backend.client, id, node: main, stopAfter: 2 });
    // The first run only: from the channel's start to its first `done`, and the stream's entries
    // of the main agent (the run's prompt is its first entry) up to its `done`.
    const upToDone = seen.slice(0, seen.findIndex((entry) => tag(entry).endsWith(' done')) + 1);
    const mainSession = stream[0]?.sessionId;
    const mainEntries = stream.filter((entry) => entry.sessionId === mainSession);
    const channelBytes = JSON.stringify(upToDone).length;
    const streamBytes = JSON.stringify(
      mainEntries.filter((entry) => entry.kind === 'event' || entry.kind === 'update'),
    ).length;
    const textEntries = (entries: { type?: string }[]) =>
      entries.filter((entry) => entry.type === 'text_delta').length;

    expect(channelBytes).toBeGreaterThan(0);
    expect(streamBytes).toBeGreaterThan(0);
    expect(channelBytes).toBeLessThan(streamBytes * 1.25);
    // The run has two turns: three deltas of words in the first and one in the second. The stream
    // holds four, the channel two (the first turn's three are stored as one).
    expect(
      textEntries(mainEntries.flatMap((entry) => (entry.kind === 'event' ? [entry.event] : []))),
    ).toBe(4);
    expect(
      textEntries(upToDone.flatMap((entry) => (entry.type === 'event' ? [entry.event] : []))),
    ).toBe(2);
  });
});

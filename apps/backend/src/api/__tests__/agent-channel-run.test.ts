import { describe, expect, it } from 'vitest';
import { createClient } from '@sheavly/client/client/client.helper';
import { followNode } from '@sheavly/client/nodes/follow-node.helper';
import type { NodeChannelEntry } from '@sheavly/client/nodes/nodes.types';
import type { NodeId } from '@sheavly/protocol/node/node.types';
import type { ConversationId } from '@sheavly/protocol/server/server.types';
import { until } from '@sheavly/testing/wait/until.fake';
import { cuttingFetch } from '../../testing/cutting-fetch.fake.js';
import { useSubAgentRuns } from '../../testing/sub-agent-run.fake.js';
import { TEST_TOKEN } from '../../testing/testing.constants.js';

// A conversation that runs a prompt in which the main agent starts a sub-agent, on the real
// backend and the real loop, read from its agents' channels through the client over the real
// routes: what a client that follows one node needs to show its run, and what it costs.

const runs = useSubAgentRuns();

/** The `done` events among `entries`. */
const dones = (entries: NodeChannelEntry[]) =>
  entries.filter((entry) => entry.type === 'event' && entry.event.type === 'done');

/** Where each run starts (`run_started <cause>`) and ends (`done`) among `entries`, in order. */
const runMarks = (entries: NodeChannelEntry[]) =>
  entries.flatMap((entry) => {
    if (entry.type === 'run_started') return [`run_started ${entry.cause}`];

    return entry.type === 'event' && entry.event.type === 'done' ? ['done'] : [];
  });

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
  client: ReturnType<typeof createClient>;
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
    const { backend, id, main, child } = await runs.ranFirst();
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

  it('reads each run from its start: run_started, the run’s events and done, and again for the run the report woke', async () => {
    const { backend, id, main } = await runs.ranFirst();
    const seen = await followed({ client: backend.client, id, node: main, stopAfter: 2 });
    const starts = seen.filter((entry) => entry.type === 'run_started');
    const firstStart = seen.findIndex((entry) => entry.type === 'run_started');
    const woken = seen.findIndex((entry) => entry.type === 'run_started' && entry.cause === 'wake');
    const firstDone = seen.findIndex(
      (entry) => entry.type === 'event' && entry.event.type === 'done',
    );
    const isEvent = (entry: NodeChannelEntry) => entry.type === 'event';

    expect(runMarks(seen)).toEqual(['run_started prompt', 'done', 'run_started wake', 'done']);
    // The prompt's start says what the user sent; the wake's has no prompt of its own.
    expect(starts[0]).toMatchObject({ cause: 'prompt', text: 'Inspect the project' });
    expect(starts[1]).toMatchObject({ cause: 'wake' });
    expect(starts[1]).not.toHaveProperty('text');
    // Every event of a run comes after its start, and none between one run's end and the next's start.
    expect(seen.slice(0, firstStart).some(isEvent)).toBe(false);
    expect(woken).toBeGreaterThan(firstDone);
    expect(seen.slice(firstDone + 1, woken).some(isEvent)).toBe(false);
    // Both starts name the message the events of both runs answer, and the cursors have no gap.
    expect(new Set(starts.map((entry) => entry.messageId))).toEqual(
      new Set(seen.flatMap((entry) => (entry.type === 'event' ? [entry.messageId] : []))),
    );
    expect(seen.map((entry) => entry.cursor)).toEqual(seen.map((_entry, at) => `s${String(at)}`));
  });

  it('stores the three deltas of a few words as one entry, with the seq of the last one', async () => {
    const { backend, id, main } = await runs.ranFirst();
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
    const { backend, id, main } = await runs.ranFirst();
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
    const { backend, id, main, child } = await runs.ranFirst();
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
    const { backend, id, main, release } = await runs.started();
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
    const { backend, id, main, stream } = await runs.ranFirst();
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

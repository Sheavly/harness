import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach } from 'vitest';
import { promptEntries } from '@sheavly/client/prompt/prompt.helper';
import type { Model } from '@sheavly/protocol/model/model.types';
import type { ConversationId } from '@sheavly/protocol/server/server.types';
import { conversationIdSchema } from '@sheavly/protocol/server/server.validator';
import type { StreamEntry } from '@sheavly/protocol/stream/stream.types';
import { fakeFetch } from '@sheavly/testing/fetch/fake-fetch.fake';
import { testBackend } from './backend.fake.js';
import { modelRequest } from './model-request.fake.js';
import { seedModel } from './seed-model.fake.js';
import { untilSettled } from './settled.fake.js';

/** The first prompt of a run, and the task its main agent gives the sub-agent it starts. */
const FIRST = 'Inspect the project';
const CHILD_TASK = 'READER_TASK';

/** What a model call reports of its tokens, as the provider's API words it, and the model's price. */
type RunOptions = {
  /** The `usage` of each model response, as the responses API sends it (tokens, cache details). */
  usage?: object;
  /** What the model costs, USD per million tokens: a call is then priced from what it reported. */
  pricing?: NonNullable<Model['pricing']>;
};

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

/**
 * Test-only: the model of the run: the first prompt makes the main agent say a few words (three
 * deltas) and start a sub-agent; the sub-agent waits for `release`, then reports its status and says
 * it is done; what follows for the main agent (the report that wakes it) is answered in a few words.
 * The sub-agent waiting is what makes the main agent's first run end before the report, so the run
 * the report wakes is a second one, whatever the timing: four model calls in all, the main agent's
 * two and the sub-agent's two. Each reports `usage`.
 */
function scriptedModel(params: {
  release: Promise<undefined>;
  usage: object;
}): typeof globalThis.fetch {
  const completed = { type: 'response.completed', response: { usage: params.usage } };
  let childCalls = 0;
  let mainCalls = 0;

  return async (input, init) => {
    const { task } = await modelRequest(input, init);

    if (task === CHILD_TASK) {
      await params.release;
      childCalls += 1;

      return fakeFetch(
        childCalls === 1
          ? [call({ id: 'r1', name: 'report_status', input: { status: 'reading' } }), completed]
          : [text('Child finished.'), completed],
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
            completed,
          ]
        : [text(`Main turn ${String(mainCalls)}.`), completed],
    ).fetch(input, init);
  };
}

/**
 * Test-only: the real backends a test opens for a run, each closed after the test with its folder
 * removed. Call it once in the test file. Closing a backend releases the sub-agent first: a test that
 * failed before it did would otherwise leave the sub-agent waiting, and the close would wait for it.
 */
export function useSubAgentRuns() {
  const opened: { base: string; close: () => Promise<void> }[] = [];

  afterEach(async () => {
    for (const { base, close } of opened.splice(0)) {
      await close();
      await rm(base, { recursive: true, force: true });
    }
  });

  /** A real backend over a folder made for the test, with the scripted model as its network. */
  async function openBackend(params: { gate: PromiseWithResolvers<undefined> } & RunOptions) {
    const base = await mkdtemp(path.join(tmpdir(), 'sub-agent-run-'));

    await mkdir(path.join(base, 'project'));

    const backend = testBackend({
      home: path.join(base, 'home'),
      workspace: path.join(base, 'project'),
      fetch: scriptedModel({
        release: params.gate.promise,
        usage: params.usage ?? { input_tokens: 100, output_tokens: 20 },
      }),
    });

    opened.push({
      base,
      close: () => {
        params.gate.resolve(undefined);

        return backend.conversations.closeAll();
      },
    });
    await seedModel({ backend, ...(params.pricing && { pricing: params.pricing }) });

    return backend;
  }

  /** Sends `prompt` to conversation `id` and reads the main agent's stream entries until its run ends. */
  async function sentPrompt(params: {
    backend: Awaited<ReturnType<typeof openBackend>>;
    id: ConversationId;
    prompt: string;
  }) {
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
  async function started(options: RunOptions = {}) {
    const gate = Promise.withResolvers<undefined>();
    const backend = await openBackend({ gate, ...options });
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

  /** `started`, with the sub-agent released and everything it started settled and stored. */
  async function ranFirst(options: RunOptions = {}) {
    const run = await started(options);
    const live = run.backend.conversations.get(run.id);

    run.release();
    await untilSettled(live);
    await live.harness.nodeChannels?.flush();
    await live.harness.usageChannel?.flush();

    return run;
  }

  return { started, ranFirst };
}

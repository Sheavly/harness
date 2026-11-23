import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { promptEntries } from '@sheavly/client/prompt/prompt.helper';
import { fakeFetch } from '@sheavly/testing/fetch/fake-fetch.fake';
import type { ConversationId } from '@sheavly/protocol/server/server.types';
import { testBackend } from '../../testing/backend.fake.js';
import { modelRequest } from '../../testing/model-request.fake.js';
import { seedFakeModel } from '../../testing/seed-model.fake.js';

// Flow rule 5: a finished sub-agent's report is a persistent notice, so a conversation closed and
// reopened returns it, whole, from its stored history.

const TASK = 'REPORT_TASK';

/** The model: the parent starts one sub-agent, the sub-agent answers, the parent then ends. */
const model: typeof globalThis.fetch = async (input, init) => {
  const request = await modelRequest(input, init);
  const asked = request.task;
  const used = JSON.stringify(request.input);
  const answer = (delta: string) => fakeFetch([{ type: 'response.output_text.delta', delta }]);

  if (asked === TASK) return answer('Whole report text').fetch(input, init);

  if (used.includes('Whole report text')) return answer('Parent is done').fetch(input, init);

  // After the start, before the report: the model has nothing to add, so it ends its turn.
  if (used.includes('Started sub-agent')) return answer('Waiting for it').fetch(input, init);

  return fakeFetch([
    {
      type: 'response.output_item.done',
      item: {
        type: 'function_call',
        call_id: 'start-1',
        name: 'start_agent',
        arguments: JSON.stringify({ description: 'Start', title: 'Reporter', task: TASK }),
      },
    },
  ]).fetch(input, init);
};

/** Like `model`, but the sub-agent's call never answers: it ends only when it is aborted. */
const hangingChild: typeof globalThis.fetch = async (input, init) => {
  const { task } = await modelRequest(input, init);

  if (task !== TASK) return model(input, init);

  return new Promise<Response>((_resolve, reject) => {
    init?.signal?.addEventListener('abort', () => reject(new Error('aborted')));
  });
};

type Client = ReturnType<typeof testBackend>['client'];
type ReopenedChat = { client: Client; id: ConversationId };

/** The conversation's stored sub-agent reports, as a UI reads them from its history. */
async function reportsOf(params: ReopenedChat) {
  const { client, id } = params;

  return (await client.call('getMessages', { id })).messages.flatMap((message) =>
    message.role === 'notice' && message.notice.kind === 'agent-report'
      ? [
          {
            title: message.notice.agent.title,
            outcome: message.notice.outcome,
            report: message.notice.report,
          },
        ]
      : [],
  );
}

/** Closes the conversation and reopens it, as a restart does. */
async function reopen(params: ReopenedChat) {
  await params.client.send('closeConversation', { id: params.id });
  await params.client.call('reopenConversation', { id: params.id });
}

/**
 * A real backend whose model is `fetch`, with one conversation that was sent one prompt and drained
 * to the end of its turn; `run` then reads or reopens it. Everything is removed afterwards.
 */
async function afterOnePrompt(params: {
  fetch: typeof globalThis.fetch;
  run: (conversation: ReopenedChat) => Promise<void>;
}) {
  const base = await mkdtemp(path.join(tmpdir(), 'sub-agent-report-reopen-'));
  const workspace = path.join(base, 'project');

  await mkdir(workspace);
  const backend = testBackend({ home: path.join(base, 'home'), workspace, fetch: params.fetch });

  try {
    await seedFakeModel(backend);
    const { client } = backend;
    const { id } = await client.call('startConversation', { body: {} });

    for await (const _entry of promptEntries({ client, id, prompt: { text: 'go' } })) {
      // Drained to the end of the parent's turn.
    }

    await params.run({ client, id });
  } finally {
    await backend.conversations.closeAll();
    await rm(base, { recursive: true, force: true });
  }
}

describe('a sub-agent report that was never delivered', () => {
  it('is delivered by the reopened conversation as an interrupted report, once', async () => {
    await afterOnePrompt({
      fetch: hangingChild,
      run: async (conversation) => {
        // The turn ended with the sub-agent running; closing cancels it and no report is delivered.
        await reopen(conversation);

        const expected = [{ title: 'Reporter', outcome: 'interrupted', report: '' }];

        expect(await reportsOf(conversation)).toEqual(expected);

        await reopen(conversation);

        expect(await reportsOf(conversation)).toEqual(expected);
      },
    });
  });
});

describe('a sub-agent report across a restart', () => {
  it('is returned whole by the reopened conversation, with the sub-agent card', async () => {
    await afterOnePrompt({
      fetch: model,
      run: async (conversation) => {
        // The report is delivered, and the notice stored, before the turn finishes.
        const before = await reportsOf(conversation);

        await reopen(conversation);

        expect(before).toEqual([
          { title: 'Reporter', outcome: 'completed', report: 'Whole report text' },
        ]);
        expect(await reportsOf(conversation)).toEqual(before);
      },
    });
  });
});

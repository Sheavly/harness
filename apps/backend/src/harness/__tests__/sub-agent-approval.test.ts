import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { watchApprovals } from '@sheavly/client/approvals/approvals.helper';
import type { HeardApproval } from '@sheavly/client/approvals/approvals.types';
import { promptEntries } from '@sheavly/client/prompt/prompt.helper';
import { fakeFetch } from '@sheavly/testing/fetch/fake-fetch.fake';
import { until } from '@sheavly/testing/wait/until.fake';
import type { ApprovalId } from '@sheavly/protocol/approval/approval.types';
import type { ConversationId } from '@sheavly/protocol/server/server.types';
import type { StreamEntry } from '@sheavly/protocol/stream/stream.types';
import { testBackend } from '../../testing/backend.fake.js';
import { seedFakeModel } from '../../testing/seed-model.fake.js';
import { untilSettled } from '../../testing/settled.fake.js';

type ModelInput = {
  role?: string;
  type?: string;
  content?: string | { type: string; text: string }[];
}[];
type TestBackend = ReturnType<typeof testBackend>;

/** The parent starts one sub-agent; the sub-agent runs a command that needs approval. */
function scriptedModel(): typeof globalThis.fetch {
  return async (input, init) => {
    const body = JSON.parse(await new Request(input, init).text()) as { input: ModelInput };
    const content = body.input.find((item) => item.role === 'user')?.content;
    const task = Array.isArray(content) ? content.map((block) => block.text).join('') : content;
    const resumed = body.input.some((item) => item.type === 'function_call_output');
    const call = (name: string, args: Record<string, string>) =>
      fakeFetch([
        {
          type: 'response.output_item.done',
          item: {
            type: 'function_call',
            call_id: `${name}-call`,
            name,
            arguments: JSON.stringify({ description: 'Step', ...args }),
          },
        },
      ]).fetch(input, init);
    const say = (delta: string) =>
      fakeFetch([{ type: 'response.output_text.delta', delta }]).fetch(input, init);

    if (task === 'SUB_TASK') {
      return resumed ? say('sub-agent done') : call('run_command', { command: 'echo approved' });
    }

    return resumed
      ? say('parent done')
      : call('start_agent', { title: 'Helper', task: 'SUB_TASK' });
  };
}

let base = '';
let backend: TestBackend | undefined;

/** A backend whose model starts the helper, in a fresh folder, with a conversation open. */
async function openConversation(): Promise<{ client: TestBackend['client']; id: ConversationId }> {
  base = await mkdtemp(path.join(tmpdir(), 'sub-agent-approval-'));
  const workspace = path.join(base, 'project');

  await mkdir(workspace);
  backend = testBackend({ home: path.join(base, 'home'), workspace, fetch: scriptedModel() });
  await seedFakeModel(backend);

  const { id } = await backend.client.call('startConversation', { body: {} });

  return { client: backend.client, id };
}

/** Sends the prompt and reads its stream to the end. */
async function runPrompt(params: {
  client: TestBackend['client'];
  id: ConversationId;
}): Promise<StreamEntry[]> {
  const entries: StreamEntry[] = [];

  for await (const entry of promptEntries({
    client: params.client,
    id: params.id,
    prompt: { text: 'Run the helper' },
  })) {
    entries.push(entry);
  }

  if (!backend) return entries;

  // The prompt ends when the main model finishes; the sub-agent's command still runs, so what it
  // did is read from the conversation's combined stream once everything has settled.
  const live = backend.conversations.get(params.id);

  await untilSettled(live);
  const everything: StreamEntry[] = [];

  live.harness.sessions.subscribeEntries((entry) => everything.push(entry), { replay: true })();

  return everything;
}

afterEach(async () => {
  await backend?.conversations.closeAll();
  backend = undefined;
  if (base) await rm(base, { recursive: true, force: true });
});

describe('a sub-agent that needs the user to approve a command', () => {
  it('asks over the stream naming the sub-agent, waits for the answer, then runs the command', async () => {
    const { client, id } = await openConversation();
    const stop = new AbortController();
    const heard: HeardApproval[] = [];

    // `ended` is not awaited: an in-process app can't cancel a body mid-read the way a real
    // connection does on abort, so it would wait for the stream to close on its own.
    await watchApprovals({
      client,
      id,
      signal: stop.signal,
      onApproval: (approval) => {
        heard.push(approval);

        if (approval.update.type !== 'approval_requested') return;

        // The user answers once the question is on screen, as the terminal does.
        void client.send('answerApproval', {
          id,
          approval: approval.update.request.id,
          body: { response: { decision: 'approve' } },
        });
      },
    });

    const entries = await runPrompt({ client, id });

    stop.abort();
    await until(() => heard.some(({ update }) => update.type === 'approval_resolved'));

    const asked = heard.find(({ update }) => update.type === 'approval_requested');

    // Named for the UI, and the id is there too, for one that renders it its own way.
    expect(asked?.agent).toMatchObject({ title: 'Helper', depth: 2 });
    expect(asked?.sessionId).toBe(asked?.agent?.id);
    expect(asked?.update).toMatchObject({
      type: 'approval_requested',
      request: { tool: 'run_command', command: 'echo approved' },
    });

    // It waited for the answer instead of being refused, then ran.
    const ran = entries.find(
      (entry) =>
        entry.kind === 'event' &&
        entry.event.type === 'tool_result' &&
        entry.sessionId === asked?.sessionId,
    );

    expect(JSON.stringify(ran)).toContain('approved');
    expect(JSON.stringify(ran)).toContain('"isError":false');
    expect(JSON.stringify(entries)).not.toContain("needs the user's approval");
  });

  it('does not let another conversation answer an approval that waits in this one', async () => {
    const { client, id } = await openConversation();
    const other = await client.call('startConversation', { body: {} });
    const stop = new AbortController();
    const asked = Promise.withResolvers<ApprovalId>();

    await watchApprovals({
      client,
      id,
      signal: stop.signal,
      onApproval: ({ update }) => {
        if (update.type === 'approval_requested') asked.resolve(update.request.id);
      },
    });

    const running = runPrompt({ client, id });
    const approval = await asked.promise;
    const answer = { decision: 'approve' } as const;

    // Each conversation has its own registry, so its id is unknown to the other one.
    await expect(
      client.send('answerApproval', { id: other.id, approval, body: { response: answer } }),
    ).rejects.toMatchObject({ code: 'unknown_approval' });

    // The command still waits, and the conversation it belongs to can answer it.
    await client.send('answerApproval', { id, approval, body: { response: answer } });
    expect(JSON.stringify(await running)).not.toContain("needs the user's approval");
    stop.abort();
  });

  it('refuses the sub-agent’s command at once when no UI answers approvals', async () => {
    const entries = await runPrompt(await openConversation());

    expect(JSON.stringify(entries)).toContain("needs the user's approval");
  });
});

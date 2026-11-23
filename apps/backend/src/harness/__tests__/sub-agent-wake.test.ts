import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { promptEntries } from '@sheavly/client/prompt/prompt.helper';
import { fakeFetch } from '@sheavly/testing/fetch/fake-fetch.fake';
import { until } from '@sheavly/testing/wait/until.fake';
import type { StreamEntry } from '@sheavly/protocol/stream/stream.types';
import { testBackend } from '../../testing/backend.fake.js';
import { modelRequest } from '../../testing/model-request.fake.js';
import { seedFakeModel } from '../../testing/seed-model.fake.js';
import { untilSettled } from '../../testing/settled.fake.js';

describe('sub-agent completion over the terminal prompt stream', () => {
  it('ends the prompt, then wakes the parent with each review as it finishes', async () => {
    const base = await mkdtemp(path.join(tmpdir(), 'sub-agent-wake-'));
    const workspace = path.join(base, 'project');
    const first = Promise.withResolvers<undefined>();
    const second = Promise.withResolvers<undefined>();
    const requests: string[] = [];
    let parentCalls = 0;
    const fetch: typeof globalThis.fetch = async (input, init) => {
      const body = await modelRequest(input, init);
      const { task } = body;
      const review = [
        { task: 'FIRST_REVIEW_TASK', finish: first, reply: 'First review findings' },
        { task: 'SECOND_REVIEW_TASK', finish: second, reply: 'Second review findings' },
      ].find((review) => review.task === task);

      if (review) {
        await review.finish.promise;

        return fakeFetch([{ type: 'response.output_text.delta', delta: review.reply }]).fetch(
          input,
          init,
        );
      }

      parentCalls++;
      requests.push(JSON.stringify(body.input));

      if (parentCalls === 1) {
        return fakeFetch(
          ['FIRST_REVIEW_TASK', 'SECOND_REVIEW_TASK'].map((task, index) => ({
            type: 'response.output_item.done',
            item: {
              type: 'function_call',
              call_id: `review-${index}`,
              name: 'start_agent',
              arguments: JSON.stringify({ description: 'Start review', title: task, task }),
            },
          })),
        ).fetch(input, init);
      }

      return fakeFetch([
        { type: 'response.output_text.delta', delta: `Parent turn ${parentCalls}` },
      ]).fetch(input, init);
    };

    await mkdir(workspace);
    const backend = testBackend({ home: path.join(base, 'home'), workspace, fetch });
    let running: Promise<void> | undefined;

    try {
      await seedFakeModel(backend);
      const { id } = await backend.client.call('startConversation', { body: {} });
      const entries: StreamEntry[] = [];
      let ended = false;

      running = (async () => {
        for await (const entry of promptEntries({
          client: backend.client,
          id,
          prompt: { text: 'Review the branch' },
        })) {
          entries.push(entry);
        }

        ended = true;
      })();
      // The prompt ends when the parent's model finishes, with both reviews still running.
      await running;
      expect(parentCalls).toBe(2);
      expect(ended).toBe(true);
      expect(entries.some((entry) => entry.kind === 'event' && entry.event.type === 'done')).toBe(
        true,
      );

      // Each finished review wakes the idle parent by itself; the stream every UI follows
      // carries what that run does.
      const live = backend.conversations.get(id);

      live.harness.sessions.subscribeEntries((entry) => entries.push(entry));
      first.resolve(undefined);
      await until(() => parentCalls === 3);
      expect(requests[2]).toContain('First review findings');
      second.resolve(undefined);
      await until(() => parentCalls === 4);
      await untilSettled(live);
      expect(requests[3]).toContain('Second review findings');
      expect(
        entries.filter((entry) => entry.kind === 'event' && entry.event.type === 'task_completed'),
      ).toHaveLength(2);
      const history = await backend.client.call('getMessages', { id });

      expect(
        history.messages.filter(
          (message) => 'content' in message && message.content === 'Review the branch',
        ),
      ).toHaveLength(1);

      // Each report is also in the stored history as typed data, so a reopened conversation
      // returns it, whole, with the sub-agent's card fields.
      const reports = history.messages.flatMap((message) =>
        message.role === 'notice' && message.notice.kind === 'agent-report'
          ? [{ title: message.notice.agent.title, report: message.notice.report }]
          : [],
      );

      expect(reports).toHaveLength(2);
      expect(reports.map(({ report }) => report).sort()).toEqual([
        'First review findings',
        'Second review findings',
      ]);
      expect(reports.map(({ title }) => title).sort()).toEqual([
        'FIRST_REVIEW_TASK',
        'SECOND_REVIEW_TASK',
      ]);
      // The same payload went out on the stream.
      expect(
        entries.filter(
          (entry) =>
            entry.kind === 'event' &&
            entry.event.type === 'harness_notice' &&
            entry.event.notice.kind === 'agent-report',
        ),
      ).toHaveLength(2);
      expect(
        entries.some(
          (entry) =>
            entry.kind === 'event' &&
            entry.event.type === 'done' &&
            entry.event.reason === 'completed',
        ),
      ).toBe(true);
    } finally {
      first.resolve(undefined);
      second.resolve(undefined);
      await running;
      await backend.conversations.closeAll();
      await rm(base, { recursive: true, force: true });
    }
  });
});

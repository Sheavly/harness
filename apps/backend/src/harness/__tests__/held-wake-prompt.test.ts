import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { promptEntries } from '@sheavly/client/prompt/prompt.helper';
import { conversationIdSchema } from '@sheavly/protocol/server/server.validator';
import type { StreamEntry } from '@sheavly/protocol/stream/stream.types';
import { fakeFetch } from '@sheavly/testing/fetch/fake-fetch.fake';
import { until } from '@sheavly/testing/wait/until.fake';
import { testBackend } from '../../testing/backend.fake.js';
import { modelRequest } from '../../testing/model-request.fake.js';
import { seedFakeModel } from '../../testing/seed-model.fake.js';
import { untilSettled } from '../../testing/settled.fake.js';

/** A model call that makes one tool call. */
const calling = (params: { id: string; name: string; args: object }) => [
  {
    type: 'response.output_item.done',
    item: {
      type: 'function_call',
      call_id: params.id,
      name: params.name,
      arguments: JSON.stringify({ description: params.name, ...params.args }),
    },
  },
];

/** A model call that says `text` and ends its turn. */
const saying = (text: string) => [{ type: 'response.output_text.delta', delta: text }];

describe('a line sent while the conversation waits on grouped work it started itself', () => {
  it('is answered at once as queued, and starts only once the model has seen the grouped result', async () => {
    const base = await mkdtemp(path.join(tmpdir(), 'held-wake-'));
    const workspace = path.join(base, 'project');
    const reviews = {
      FIRST_REVIEW: Promise.withResolvers<undefined>(),
      SECOND_REVIEW: Promise.withResolvers<undefined>(),
    };
    const parent: string[] = [];
    // The parent's turns, in order: start a review and end the prompt; then, woken by its end,
    // start another, group it, and end that turn held on it; then answer once it is in; then the
    // line sent meanwhile.
    const turns = [
      calling({ id: 'first', name: 'start_agent', args: { title: 'First', task: 'FIRST_REVIEW' } }),
      saying('Started the first review.'),
      calling({
        id: 'second',
        name: 'start_agent',
        args: { title: 'Second', task: 'SECOND_REVIEW' },
      }),
      calling({ id: 'wait', name: 'await_tasks', args: { ids: ['t2'], reason: 'Need it' } }),
      saying('Waiting for the second review.'),
      saying('Both reviews are in.'),
      saying('Answering the line.'),
    ];
    const fetch: typeof globalThis.fetch = async (input, init) => {
      const body = await modelRequest(input, init);
      const { task } = body;

      if (task === 'FIRST_REVIEW' || task === 'SECOND_REVIEW') {
        await reviews[task].promise;

        return fakeFetch(saying(`${task} findings`)).fetch(input, init);
      }

      parent.push(JSON.stringify(body.input));

      return fakeFetch(turns[parent.length - 1] ?? saying('More.')).fetch(input, init);
    };

    await mkdir(workspace);
    const backend = testBackend({ home: path.join(base, 'home'), workspace, fetch });

    try {
      await seedFakeModel(backend);
      const { client } = backend;
      const { id } = await client.call('startConversation', { body: {} });
      const live = backend.conversations.get(conversationIdSchema.parse(id));
      const entries: StreamEntry[] = [];

      live.harness.sessions.subscribeEntries((entry) => entries.push(entry));

      for await (const _entry of promptEntries({ client, id, prompt: { text: 'go' } }));

      reviews.FIRST_REVIEW.resolve(undefined);
      await until(() =>
        entries.some(
          (e) => e.kind === 'event' && e.event.type === 'run_state' && e.event.groupedTasks === 1,
        ),
      );

      // Before, this request got no answer until the grouped work and the model had finished.
      expect(await client.call('sendPrompt', { id, body: { text: 'meanwhile' } })).toEqual({
        status: 'queued',
        queued: ['meanwhile'],
      });
      expect(live.conversation.state).toBe('wake');
      expect(parent).toHaveLength(5);

      reviews.SECOND_REVIEW.resolve(undefined);
      await until(() => parent.length === 7);
      await untilSettled(live);

      // The model saw the grouped result and finished before the queued line started.
      expect(parent[5]).toContain('SECOND_REVIEW findings');
      expect(parent[5]).not.toContain('meanwhile');
      expect(parent[6]).toContain('meanwhile');
    } finally {
      await backend.conversations.closeAll();
      await rm(base, { recursive: true, force: true });
    }
  });
});

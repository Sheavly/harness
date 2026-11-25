import { setTimeout as sleep } from 'node:timers/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { mkdtemp, readFile } from 'node:fs/promises';
import { describe, expect, it, vi } from 'vitest';
import { taskInfoSchema } from '@sheavly/protocol/task/task.validator';
import type { StreamEntry } from '@sheavly/protocol/stream/stream.types';
import { fakeServer } from '@sheavly/client/testing/fake-server.fake';
import { WorkbookStore } from '../store.service.js';
import { runWorkbook } from '../run.helper.js';
import {
  fakeRunRequest,
  fakeConversationDetails,
  useWorkbookRunEnvironment,
  FAKE_CONVERSATION,
  FAKE_MAIN_SESSION,
} from '../../testing/workbook-run.fake.js';
import { connectBackend } from '../../client/backend.helper.js';
import { liveFeed, promptStarted } from '../../testing/live-feed.fake.js';
import { startedAnswer } from '../../chat/testing/prompt-answers.fake.js';
import { endsOnAbort } from '../../testing/remote-conversation.fake.js';

// The same two replacements every workbook run test makes: the backend, and Git.
vi.mock('node:child_process', () => ({ execFileSync: vi.fn(() => '') }));
vi.mock('../../client/backend.helper.js', () => ({ connectBackend: vi.fn() }));

const id = FAKE_CONVERSATION;
const main = FAKE_MAIN_SESSION;
const request = fakeRunRequest('Start a background check, then finish');
const environment = useWorkbookRunEnvironment();
const task = {
  id: 't1',
  command: 'sleep 1',
  description: 'a background check',
  kind: 'task',
  status: 'running',
  startedAt: 0,
  output: '',
};
const taskEntry = (params: { seq: number; ended: boolean }): StreamEntry => ({
  seq: params.seq,
  at: 0,
  sessionId: main,
  kind: 'task',
  update: params.ended
    ? {
        type: 'task_ended',
        task: taskInfoSchema.parse({ ...task, status: 'completed', endedAt: 1, exitCode: 0 }),
      }
    : { type: 'task_started', task: taskInfoSchema.parse(task) },
});

const textEntry = (seq: number, text = 'WOKEN_REPLY'): StreamEntry => ({
  seq,
  at: 0,
  sessionId: main,
  kind: 'event',
  event: { seq, type: 'text_delta', text },
});

const done = (seq: number): StreamEntry => ({
  seq,
  at: 0,
  sessionId: main,
  kind: 'event',
  event: {
    seq,
    type: 'done',
    reason: 'completed',
    session: { id: main, rootId: main, depth: 1 },
  },
});

/**
 * A backend that ends the prompt while a command still runs, as the real one does when the model
 * stops without `await_tasks`. The run it then starts to deliver the finished command comes after
 * the prompt's `done`, so only a follower of the whole stream sees it, not the prompt's entries.
 */
async function backendThatWakes() {
  const root = await mkdtemp(path.join(tmpdir(), 'workbook-background-'));

  environment.keep(root);

  const store = new WorkbookStore(path.join(root, 'workbook'));
  const liveEnded = Promise.withResolvers<undefined>();
  const feed = liveFeed();
  const server = fakeServer({
    startConversation: () => ({ id }),
    getConversation: () => fakeConversationDetails(store.runWorkspaceDir(request.name)),
    sendPrompt: ({ body }) => {
      feed.publish(
        promptStarted({ seq: 0, text: (body as { text: string }).text }),
        taskEntry({ seq: 1, ended: false }),
        done(2),
      );
      // The command finishes after the prompt ended, and the backend starts a run to deliver it.
      void sleep(300).then(() =>
        feed.publish(taskEntry({ seq: 5, ended: true }), textEntry(6), done(7)),
      );

      return startedAnswer();
    },
    async *streamConversation({ body }) {
      if (!(body as { replay?: boolean }).replay) yield* feed.follow();
      await liveEnded.promise;
    },
    getMessages: () => ({ messages: [] }),
    closeConversation: () => {
      liveEnded.resolve(undefined);
    },
    stopPrompt: () => undefined,
  });

  vi.mocked(connectBackend).mockResolvedValue({
    url: 'http://fake.test',
    token: 'fake',
    fetch: async (input, init) => {
      init?.signal?.addEventListener('abort', () => liveEnded.resolve(undefined), { once: true });

      return endsOnAbort({ response: await server.fetch(input, init), signal: init?.signal });
    },
    stop: vi.fn(async () => undefined),
  });

  return { store };
}

describe('a run whose prompt ends while background work still runs', () => {
  it('records the run the backend starts to deliver the finished work', async () => {
    const { store } = await backendThatWakes();
    const result = await runWorkbook({ store, request });

    // The prompt's entries end with its `done`. The woken run's text and its `done` came later:
    // without following the whole stream they are never recorded.
    expect(result.outcome).toBe('completed');
    expect(result.events).toBe(3);
    expect(result.lastEvent).toBe('#7 done');
  });

  it('shows each entry once although the prompt’s entries and the followed stream both carry it', async () => {
    const { store } = await backendThatWakes();
    const result = await runWorkbook({ store, request });
    const transcript = await readFile(store.paths(result.id).transcript, 'utf8');

    expect(transcript.split('WOKEN_REPLY')).toHaveLength(2);
  });
});

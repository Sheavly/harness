import { describe, expect, it } from 'vitest';
import type { StreamEntry } from '@sheavly/protocol/stream/stream.types';
import { taskIdSchema } from '@sheavly/protocol/task/task.validator';
import { ENDED_TASKS_KEPT } from '../client.constants.js';
import {
  FAKE_MAIN as MAIN,
  doneAt,
  openOnFake,
  sentEntries,
  taskEnded,
  taskStarted,
} from '../../testing/remote-conversation.fake.js';

/** A conversation that sends one prompt per run of `runs`, with the task counts it was told. */
async function sendingAll(runs: StreamEntry[][]) {
  const { conversation } = await openOnFake({ runs });
  const told: number[] = [];

  conversation.watchBackground(({ tasks }) => told.push(tasks));
  for (const _run of runs) await sentEntries({ conversation });

  return { told, conversation };
}

const NONE = { tasks: 0, agents: 0, services: 0 };

describe('RemoteConversation: the background work it counts', () => {
  it('counts a background task from its start in the stream to its end', async () => {
    const { conversation } = await openOnFake({
      runs: [[taskStarted(1), taskEnded(2), doneAt(3)]],
    });
    const counts: number[] = [];

    for await (const entry of conversation.send({ text: 'hi' })) {
      if (entry.kind !== 'queue') counts.push(conversation.runningTasks);
    }

    expect(counts).toEqual([1, 0, 0]);
  });

  it('splits what runs in the background into tasks, agents and services, and tells a watcher', async () => {
    const told: (typeof NONE)[] = [];
    const { conversation } = await openOnFake({
      runs: [
        [
          taskStarted(1, 't1', 'service'),
          taskStarted(2, 't2', 'task'),
          taskStarted(3, 't3', 'task'),
          taskStarted(4, 't4', 'agent'),
          taskEnded(5, 't1'),
          doneAt(6),
        ],
      ],
    });

    conversation.watchBackground((background) => told.push(background));
    await sentEntries({ conversation });

    expect(told).toEqual([
      NONE,
      { tasks: 0, agents: 0, services: 1 },
      { tasks: 1, agents: 0, services: 1 },
      { tasks: 2, agents: 0, services: 1 },
      { tasks: 2, agents: 1, services: 1 },
      { tasks: 2, agents: 1, services: 0 },
    ]);
    expect(conversation.background).toEqual({ tasks: 2, agents: 1, services: 0 });
  });

  it('does not bring a task back when its start is seen again after its end', async () => {
    // The second run replays the start after the end was counted, as a second follower can.
    const { told, conversation } = await sendingAll([
      [taskStarted(1), taskEnded(2), doneAt(3)],
      [taskStarted(1), doneAt(4)],
    ]);

    expect(told).toEqual([0, 1, 0]);
    expect(conversation.background).toEqual(NONE);
  });

  it('treats ended as final: an end seen before its start, or twice, never counts a task', async () => {
    const { told, conversation } = await sendingAll([
      [taskEnded(1), taskStarted(2), doneAt(3)],
      [taskEnded(1), doneAt(4)],
    ]);

    // Told once on subscribe; the end came first, so the late start and the repeated end say nothing.
    expect(told).toEqual([0]);
    expect(conversation.background).toEqual(NONE);
  });

  it('remembers only the last ENDED_TASKS_KEPT ended ids, so a long chat does not grow', async () => {
    const total = ENDED_TASKS_KEPT + 5;
    const ids = Array.from({ length: total }, (_, index) => `t${String(index + 1)}`);
    const lifecycles = ids.flatMap((id, index) => [
      taskStarted(index * 2 + 1, id),
      taskEnded(index * 2 + 2, id),
    ]);
    const { conversation } = await sendingAll([
      [...lifecycles, doneAt(total * 2 + 1)],
      // The oldest id was forgotten, so a start for it counts again; the newest is still known.
      [taskStarted(1, 't1'), taskStarted(2, ids[total - 1] ?? ''), doneAt(3)],
    ]);

    expect(conversation.background).toEqual({ tasks: 1, agents: 0, services: 0 });
  });

  it('counts another task’s start that arrives with a lower seq than one already counted', async () => {
    const { conversation } = await sendingAll([
      [taskStarted(12, 't1'), doneAt(13)],
      [taskStarted(9, 't2'), doneAt(14)],
    ]);

    expect(conversation.background).toEqual({ tasks: 2, agents: 0, services: 0 });
  });

  it('counts a task as ended when the next prompt is told it completed', async () => {
    const completed: StreamEntry = {
      seq: 1,
      at: 0,
      sessionId: MAIN,
      kind: 'event',
      event: {
        seq: 0,
        type: 'task_completed',
        task: {
          id: taskIdSchema.parse('t1'),
          command: 'npm run dev',
          description: 'Dev server',
          kind: 'task',
          startedAt: 1,
          output: '',
          status: 'failed',
        },
      },
    };
    const { conversation } = await openOnFake({
      runs: [
        [taskStarted(1), doneAt(2)],
        [completed, doneAt(3)],
      ],
    });

    await sentEntries({ conversation });
    expect(conversation.runningTasks).toBe(1);
    await sentEntries({ conversation });
    expect(conversation.runningTasks).toBe(0);
  });

  it('counts the tasks the live stream carries, for runs no prompt of this client sent', async () => {
    const { conversation, feed } = await openOnFake({});
    const stop = new AbortController();
    const { ended } = await conversation.follow({
      onEntry: (entry) => {
        if (entry.seq === 2) stop.abort();
      },
      signal: stop.signal,
    });

    feed.publish(taskStarted(1), doneAt(2));
    await ended;

    expect(conversation.runningTasks).toBe(1);
  });
});

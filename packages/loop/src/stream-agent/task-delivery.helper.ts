import { now } from '@sheavly/core/clock/clock.helper';
import type { HistoryMessage } from '@sheavly/protocol/history/history.types';
import type { HarnessNotice } from '@sheavly/protocol/notice/notice.types';
import type { TaskInfo } from '@sheavly/protocol/task/task.types';
import type { RunSession } from '@sheavly/runtime/sessions/sessions.types';
import type { TaskRegistry } from '@sheavly/runtime/tasks/tasks.service';
import type { AgentEvents } from './stream-agent.types.js';
import { publishNotice } from './notice-publish.helper.js';
import { finishedTaskNotice } from './task-notice.helper.js';
import { taskCompletionContext } from './task-context.utils.js';

/**
 * Releases only ready deliveries at a turn boundary, identically to history and the stream.
 * Returns the tasks of each delivery, for the `taskCompleted` hooks.
 */
export function reportFinishedTasks(params: {
  tasks: TaskRegistry | undefined;
  session: RunSession;
  messages: HistoryMessage[];
  events: AgentEvents;
}): TaskInfo[][] {
  const { tasks, session, messages, events } = params;

  if (!tasks) return [];

  // Completion listeners may release any delivered task synchronously. Snapshot every report
  // before publishing the first event, including reports in later deliveries of this drain.
  const deliveries = tasks.takeDeliveries(session.ref.id).map((delivery) => ({
    ...delivery,
    notices: delivery.tasks.map((task) =>
      finishedTaskNotice({
        task,
        tasks,
        sessions: session.registry,
        parent: session.ref.id,
        history: messages,
      }),
    ),
    // Only a delivery with an `await_tasks` reason is a group; the rest is one notice per task.
    group:
      delivery.reason === undefined
        ? undefined
        : {
            reason: delivery.reason,
            context: taskCompletionContext({
              reason: delivery.reason,
              startedAt: Math.min(...delivery.tasks.map((task) => task.startedAt)),
              endedAt: Math.max(...delivery.tasks.map((task) => task.endedAt ?? task.startedAt)),
              history: messages,
            }),
          },
  }));

  for (const delivery of deliveries) {
    const { notices, group } = delivery;
    const notice: HarnessNotice | undefined = group
      ? { kind: 'tasks-finished', ...group, notices }
      : notices[0];

    if (!notice) continue;

    for (const task of delivery.tasks) events.enqueue({ type: 'task_completed', task });

    // One grouped event and history entry: no member notice leaks before the group is complete.
    const at = Math.max(...delivery.tasks.map((task) => task.endedAt ?? now()));

    publishNotice({ events, messages, notice, at });
  }

  // Every notice is built and in history, so nothing reads these tasks again. Silent settled
  // tasks go too: this turn's `cancel_task` result has reached the model by now.
  tasks.releaseFinished(session.ref.id);

  // `finishedTaskNotice` found each sub-agent by its session, so the session can go only now: the
  // session of every task released above, delivered or cancelled in silence (which no notice names,
  // and nothing else would release). A failed or stopped sub-agent has no report, hence a
  // `task-finished` notice, and goes too. One with work still open under it stays, not retried.
  for (const agent of tasks.takeReleasedAgents(session.ref.id)) {
    session.registry.releaseAgent(agent);
  }

  return deliveries.map((delivery) => delivery.tasks);
}

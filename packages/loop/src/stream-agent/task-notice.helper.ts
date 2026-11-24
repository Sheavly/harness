import type { SessionRegistry } from '@sheavly/runtime/sessions/sessions.service';
import type { TaskRegistry } from '@sheavly/runtime/tasks/tasks.service';
import type { HarnessNotice } from '@sheavly/protocol/notice/notice.types';
import type { RunOutcome, SessionId } from '@sheavly/protocol/session/session.types';
import type { TaskInfo } from '@sheavly/protocol/task/task.types';
import type { HistoryMessage } from '@sheavly/protocol/history/history.types';
import { taskCompletionContext } from './task-context.utils.js';

/** The notices that go in history: the kinds the model has to remember. */
type FinishedTaskNotice = Extract<HarnessNotice, { kind: 'agent-report' | 'task-finished' }>;

/**
 * The notice that tells the model a task it started has finished. A sub-agent, found by the
 * session its task runs (`TaskInfo.agentSessionId`), is an `agent-report`: its card (who it is,
 * how it ended) and the report it wrote, whole. Any other task is a `task-finished`, with its bounded output preview.
 * Both are typed data: the model is shown them as text by the core formatter, and a UI reads the
 * same data from history and from the `harness_notice` event.
 */
export function finishedTaskNotice(params: {
  task: TaskInfo;
  tasks: TaskRegistry;
  sessions: SessionRegistry;
  /** The session whose tool started the task. */
  parent: SessionId;
  /** Append-only history at delivery, before the notice itself is added. */
  history: readonly HistoryMessage[];
}): FinishedTaskNotice {
  const { task, tasks, sessions, parent, history } = params;
  const context = taskCompletionContext({
    reason: task.reason ?? task.description,
    startedAt: task.startedAt,
    endedAt: task.endedAt ?? task.startedAt,
    history,
    ...(task.callId !== undefined && { callId: task.callId }),
  });
  const report = tasks.report(task.id);
  // The session the task runs (`TaskInfo.agentSessionId`, which `start_agent` records): a tool call
  // id is a provider's, may repeat, and cannot say which sub-agent this is. A task with none is not
  // a sub-agent's.
  const { agentSessionId } = task;
  const found = agentSessionId === undefined ? undefined : sessions.get(agentSessionId);
  const agent = found && 'parentId' in found && found.parentId === parent ? found : undefined;

  if (report === undefined || !agent) {
    return { kind: 'task-finished', task, context };
  }

  return {
    kind: 'agent-report',
    agent,
    taskId: task.id,
    outcome: outcomeOf({ task, lastOutcome: agent.lastOutcome }),
    report,
    context,
  };
}

/** How the sub-agent's last run ended: what its session says, else what its task says. */
function outcomeOf(params: { task: TaskInfo; lastOutcome: RunOutcome | undefined }): RunOutcome {
  const { task, lastOutcome } = params;

  if (lastOutcome) return lastOutcome;

  if (task.status === 'completed') return 'completed';

  return task.status === 'cancelled' ? 'interrupted' : 'failed';
}

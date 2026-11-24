import { describe, expect, it } from 'vitest';
import type { SessionRegistry } from '@sheavly/runtime/sessions/sessions.service';
import type { TaskRegistry } from '@sheavly/runtime/tasks/tasks.service';
import { sessionIdSchema } from '@sheavly/protocol/session/session.validator';
import { taskInfoSchema } from '@sheavly/protocol/task/task.validator';
import { finishedTaskNotice } from '../task-notice.helper.js';

const PARENT = sessionIdSchema.parse('main-1');
const CHILD = {
  id: 'sub-1',
  parentId: PARENT,
  startedByCall: 'call-1',
  rootId: PARENT,
  depth: 2,
  title: 'Research',
  status: 'done',
  state: 'completed',
  startedAt: 1,
};

const task = (extra: Record<string, unknown> = {}) =>
  taskInfoSchema.parse({
    id: 't1',
    kind: 'task',
    command: 'ls',
    description: 'list',
    status: 'completed',
    output: '',
    startedAt: 1,
    ...extra,
  });

/** A sub-agent's task: it runs the session `CHILD`, which the task's snapshot says. */
const agentTask = (extra: Record<string, unknown> = {}) =>
  task({ kind: 'agent', callId: 'call-1', agentSessionId: 'sub-1', ...extra });

/** The registries a notice reads: the task's report, and the sessions by id. */
const registries = (params: { report: string | undefined; sessions: object[] }) => ({
  tasks: { report: () => params.report } as unknown as TaskRegistry,
  sessions: {
    get: (id: string) => params.sessions.find((session) => 'id' in session && session.id === id),
  } as unknown as SessionRegistry,
  history: [],
});

describe('finishedTaskNotice', () => {
  it('is an agent-report with the whole report when the task runs a sub-agent session', () => {
    const notice = finishedTaskNotice({
      task: agentTask(),
      parent: PARENT,
      ...registries({ report: 'THE WHOLE REPORT', sessions: [CHILD] }),
    });

    expect(notice).toMatchObject({
      kind: 'agent-report',
      taskId: 't1',
      report: 'THE WHOLE REPORT',
    });
  });

  it('is a task-finished when the task runs no session, it has no report, or the session is not its own', () => {
    const stranger = { ...CHILD, parentId: sessionIdSchema.parse('main-2') };

    expect(
      finishedTaskNotice({
        task: task({ callId: 'call-1' }),
        parent: PARENT,
        ...registries({ report: 'r', sessions: [CHILD] }),
      }).kind,
    ).toBe('task-finished');
    expect(
      finishedTaskNotice({
        task: agentTask(),
        parent: PARENT,
        ...registries({ report: undefined, sessions: [CHILD] }),
      }).kind,
    ).toBe('task-finished');
    expect(
      finishedTaskNotice({
        task: agentTask(),
        parent: PARENT,
        ...registries({ report: 'r', sessions: [stranger] }),
      }).kind,
    ).toBe('task-finished');
  });

  it('takes the outcome from the task when the session has none: a cancelled one is interrupted', () => {
    const noOutcome = { ...CHILD, lastOutcome: undefined };
    const outcomeFor = (status: string) => {
      const notice = finishedTaskNotice({
        task: agentTask({ status }),
        parent: PARENT,
        ...registries({ report: 'r', sessions: [noOutcome] }),
      });

      return notice.kind === 'agent-report' ? notice.outcome : undefined;
    };

    expect(outcomeFor('completed')).toBe('completed');
    expect(outcomeFor('failed')).toBe('failed');
    expect(outcomeFor('cancelled')).toBe('interrupted');
  });

  it('does not pair by tool call id: a child that has the task’s call id is not its sub-agent', () => {
    const notice = finishedTaskNotice({
      task: task({ callId: 'call-1' }),
      parent: PARENT,
      // The task runs no session, as a command does; a child with its call id is somebody else's.
      ...registries({ report: 'r', sessions: [CHILD] }),
    });

    expect(notice.kind).toBe('task-finished');
  });
});

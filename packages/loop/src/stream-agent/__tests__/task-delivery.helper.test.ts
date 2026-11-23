import { expect, it } from 'vitest';
import type { AgentEvent, AgentEventBody } from '@sheavly/protocol/event/event.types';
import type { HistoryMessage } from '@sheavly/protocol/history/history.types';
import { callIdSchema } from '@sheavly/protocol/message/message.validator';
import type { SessionRef } from '@sheavly/protocol/session/session.types';
import { SessionRegistry } from '@sheavly/runtime/sessions/sessions.service';
import { startHeldTask } from '@sheavly/runtime/testing/held-task.fake';
import { TaskRegistry } from '@sheavly/runtime/tasks/tasks.service';
import { until } from '@sheavly/testing/wait/until.fake';
import { OrderedQueue } from '../../queue/queue.service.js';
import { reportFinishedTasks } from '../task-delivery.helper.js';

/**
 * A sub-agent's finished task under `ref`. A `failed` one leaves no report, like a run that threw;
 * `grandchildOpen` leaves a session of its own still open under it.
 */
async function finishedAgent(params: {
  registry: SessionRegistry;
  tasks: TaskRegistry;
  ref: SessionRef;
  grandchildOpen?: boolean;
  outcome?: 'completed' | 'failed';
}) {
  const { registry, tasks, ref, outcome = 'completed' } = params;
  const callId = callIdSchema.parse('child-call');
  const child = registry.startChild({ parentId: ref.id, startedByCall: callId, title: 'Child' });

  if (params.grandchildOpen) {
    registry.startChild({ parentId: child.id, startedByCall: callIdSchema.parse('g'), title: 'G' });
  }

  registry.end({ id: child.id, state: outcome });
  tasks.start({
    command: 'sub-agent',
    description: 'Child',
    callId,
    sessionId: ref.id,
    agentSessionId: child.id,
    run: async () => (outcome === 'completed' ? { exitCode: 0, report: 'done' } : { exitCode: 1 }),
  });
  await until(() => tasks.runningCount === 0);

  return child;
}

/** Finishes one sub-agent under a fresh main session and delivers it, as a turn boundary does. */
async function deliverAgent(options: { grandchildOpen?: boolean; outcome?: 'failed' } = {}) {
  const registry = new SessionRegistry();
  const ref = registry.startMain({ title: 'Parent' });
  const tasks = new TaskRegistry(registry.nodeOwners);
  const child = await finishedAgent({ registry, tasks, ref, ...options });
  const messages: HistoryMessage[] = [];

  reportFinishedTasks({
    tasks,
    session: { registry, ref },
    messages,
    events: new OrderedQueue<AgentEventBody>(),
  });

  const kinds = messages.map((message) => message.role === 'notice' && message.notice.kind);

  return { registry, ref, child, kinds };
}

it('releases a delivered sub-agent session once its notice is in history', async () => {
  const { registry, ref, child, kinds } = await deliverAgent();

  expect(kinds).toEqual(['agent-report']);
  expect(registry.get(child.id)).toBeUndefined();
  expect(registry.isReleased(child.id)).toBe(true);
  expect(registry.get(ref.id)).toBeDefined();
});

it('releases the session of a sub-agent that failed and left no report', async () => {
  const { registry, child, kinds } = await deliverAgent({ outcome: 'failed' });

  expect(kinds).toEqual(['task-finished']);
  expect(registry.isReleased(child.id)).toBe(true);
});

it('keeps a sub-agent session whose own sub-agent is still open, and still delivers it', async () => {
  const { registry, child, kinds } = await deliverAgent({ grandchildOpen: true });

  expect(kinds).toHaveLength(1);
  expect(registry.get(child.id)).toBeDefined();
});

it('preserves every whole report when a synchronous completion listener releases all delivered tasks', async () => {
  const registry = new SessionRegistry();
  const ref = registry.startMain({ title: 'Parent' });
  const tasks = new TaskRegistry(registry.nodeOwners);
  const reports = ['first', 'second', 'ungrouped'].map((label) =>
    `${label} findings\n`.repeat(1_000),
  );
  const members = reports.map((report, index) => {
    const callId = callIdSchema.parse(`child-${String(index)}`);
    const child = registry.startChild({
      parentId: ref.id,
      startedByCall: callId,
      title: `Review ${String(index)}`,
    });

    registry.end({ id: child.id, state: 'completed' });

    return tasks.start({
      command: 'review',
      description: 'Review',
      callId,
      sessionId: ref.id,
      agentSessionId: child.id,
      run: async ({ onOutput }) => {
        onOutput(report);

        return { exitCode: 0, report };
      },
    });
  });

  tasks.group({ ids: members.slice(0, 2).map((task) => task.id), reason: 'Compare reviews' });
  await until(() => tasks.runningCount === 0);
  const released: AgentEvent[] = [];
  const events = new OrderedQueue<AgentEventBody>({
    onRelease: (event) => {
      released.push(event);
      if (event.type === 'task_completed') tasks.releaseFinished();
    },
  });
  const messages: HistoryMessage[] = [];

  reportFinishedTasks({ tasks, session: { registry, ref }, messages, events });
  const grouped = messages.find(
    (message) => message.role === 'notice' && message.notice.kind === 'tasks-finished',
  );
  const single = messages.find(
    (message) => message.role === 'notice' && message.notice.kind === 'agent-report',
  );

  expect(tasks.list()).toEqual([]);
  expect(
    grouped?.role === 'notice' &&
      grouped.notice.kind === 'tasks-finished' &&
      grouped.notice.notices,
  ).toMatchObject([
    {
      kind: 'agent-report',
      report: reports[0],
      context: { reason: 'Compare reviews', userMessagesSinceStart: 0 },
    },
    {
      kind: 'agent-report',
      report: reports[1],
      context: { reason: 'Compare reviews', userMessagesSinceStart: 0 },
    },
  ]);
  expect(single?.role === 'notice' && single.notice).toMatchObject({
    kind: 'agent-report',
    report: reports[2],
    context: { reason: 'Review', userMessagesSinceStart: 0 },
  });
  expect(released.filter((event) => event.type === 'task_completed')).toHaveLength(3);
  expect(released.filter((event) => event.type === 'harness_notice')).toHaveLength(2);
  expect(
    messages.filter((message) => message.role === 'notice').map((message) => message.notice),
  ).toEqual(
    released.filter((event) => event.type === 'harness_notice').map((event) => event.notice),
  );
});

/** A conversation with a main session, and what `deliver` runs at its turn boundary. */
function conversation() {
  const registry = new SessionRegistry();
  const ref = registry.startMain({ title: 'Parent' });
  const tasks = new TaskRegistry(registry.nodeOwners);
  const messages: HistoryMessage[] = [];
  const deliver = () =>
    reportFinishedTasks({
      tasks,
      session: { registry, ref },
      messages,
      events: new OrderedQueue<AgentEventBody>(),
    });

  return { registry, ref, tasks, messages, deliver };
}

it('releases the session of a sub-agent cancelled in silence, which no notice names', async () => {
  const { registry, ref, tasks, messages, deliver } = conversation();
  const callId = callIdSchema.parse('child-call');
  const child = registry.startChild({ parentId: ref.id, startedByCall: callId, title: 'Child' });
  const task = startHeldTask({
    tasks,
    sessionId: ref.id,
    callId,
    agentSessionId: child.id,
    backgroundKind: 'agent',
  });

  // `cancel_task` on an ungrouped task: the run stops the session as it ends, and nobody is told.
  await tasks.cancel(task.id);
  registry.end({ id: child.id, state: 'interrupted' });
  deliver();

  expect(messages).toEqual([]);
  expect(registry.isReleased(child.id)).toBe(true);
  expect(registry.nodes.list().map((node) => node.kind)).toEqual(['agent']);
});

it('leaves alone a session that has the task’s tool call id but is not the one it runs', async () => {
  const { registry, ref, tasks, messages, deliver } = conversation();
  const callId = callIdSchema.parse('same-call');
  // An extension’s child, started under the call id before the real sub-agent's.
  const other = registry.startChild({ parentId: ref.id, startedByCall: callId, title: 'Other' });
  const real = registry.startChild({ parentId: ref.id, startedByCall: callId, title: 'Real' });

  tasks.start({
    command: 'sub-agent',
    description: 'Real',
    callId,
    sessionId: ref.id,
    agentSessionId: real.id,
    backgroundKind: 'agent',
    run: async () => ({ exitCode: 0, report: 'the real report' }),
  });
  registry.end({ id: other.id, state: 'completed' });
  registry.end({ id: real.id, state: 'completed' });
  await until(() => tasks.runningCount === 0);
  deliver();

  // The card is the real sub-agent's, and it, not the other, is released.
  expect(messages.map((message) => message.role === 'notice' && message.notice)).toMatchObject([
    { kind: 'agent-report', agent: { id: real.id, title: 'Real' }, report: 'the real report' },
  ]);
  expect(registry.isReleased(real.id)).toBe(true);
  expect(registry.get(other.id)).toBeDefined();
});

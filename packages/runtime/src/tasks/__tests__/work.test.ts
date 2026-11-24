import { describe, expect, it } from 'vitest';
import { sessionIdSchema } from '@sheavly/protocol/session/session.validator';
import { taskIdSchema } from '@sheavly/protocol/task/task.validator';
import { TaskRegistry } from '../tasks.service.js';
import { runningInfo } from '../tasks.utils.js';
import { agentWork, finiteWork, isFiniteKind, serviceWork, startWork } from '../work.utils.js';
import type { TaskStarter } from '../task-scope.types.js';
import type { WorkDefinition, WorkInput } from '../work.types.js';

const owner = sessionIdSchema.parse('main');
const input: WorkInput = {
  command: 'cmd',
  description: 'work',
  sessionId: owner,
  run: ({ signal }) =>
    new Promise((resolve) => {
      signal.addEventListener('abort', () => resolve({ exitCode: null }));
    }),
};

describe('background work kinds', () => {
  it('finite work holds its run; a service does not', async () => {
    const finite = new TaskRegistry();
    const services = new TaskRegistry();

    startWork({ tasks: finite, work: finiteWork(input) });
    startWork({ tasks: services, work: serviceWork(input) });

    expect(finite.hasPendingTasks()).toBe(true);
    expect(services.hasPendingTasks()).toBe(false);

    await finite.cancelAll();
    await services.cancelAll();
  });

  it('an agent is finite work named apart: it holds its run and can be grouped', async () => {
    const tasks = new TaskRegistry();
    const agent = startWork({ tasks, work: agentWork(input) });

    expect(agent.kind).toBe('agent');
    expect(tasks.hasPendingTasks()).toBe(true);
    expect(() => tasks.group({ ids: [agent.id], reason: 'review' })).not.toThrow();
    expect(tasks.hasAwaitedTasks()).toBe(true);

    await tasks.cancelAll();
  });

  it('an agent wakes an idle session when it ends, as finite work does; a service does not', async () => {
    const tasks = new TaskRegistry();
    const quick: WorkInput = { ...input, run: async () => ({ exitCode: 0 }) };

    startWork({ tasks, work: serviceWork(quick) });
    await tasks.nextSettled();
    expect(tasks.hasWakingDeliveries()).toBe(false);
    tasks.takeDeliveries();

    startWork({ tasks, work: agentWork(quick) });
    await tasks.nextSettled();
    expect(tasks.hasWakingDeliveries()).toBe(true);
  });

  it.each([
    ['task', true],
    ['agent', true],
    ['service', false],
  ] as const)('%s is finite: %s, the one definition the registry asks', (kind, finite) => {
    expect(isFiniteKind(kind)).toBe(finite);
  });

  it('a kind decides the policy: the input cannot override it', () => {
    expect(finiteWork({ ...input, backgroundKind: 'service' } as WorkInput).backgroundKind).toBe(
      'task',
    );
    expect(serviceWork(input).backgroundKind).toBe('service');
  });

  it('work of every kind has an owner, so cancelSession stops it', async () => {
    const tasks = new TaskRegistry();

    startWork({ tasks, work: finiteWork(input) });
    startWork({ tasks, work: serviceWork(input) });

    await tasks.cancelSession(owner);

    expect(tasks.runningCount).toBe(0);
  });

  it('tells a UI the kind in the snapshot, the start update and the end update', async () => {
    const tasks = new TaskRegistry();
    const seen: (string | undefined)[] = [];

    tasks.observe(({ update }) => seen.push(update.task.kind));

    const finite = startWork({ tasks, work: finiteWork(input) });
    const service = startWork({ tasks, work: serviceWork(input) });

    expect([finite.kind, service.kind]).toEqual(['task', 'service']);
    expect(tasks.get(service.id)?.kind).toBe('service');

    await tasks.cancelAll();
    expect(seen).toEqual(['task', 'service', 'task', 'service']);
  });

  it('starts the work in anything that satisfies TaskStarter, with the factory policy', () => {
    const seen: WorkDefinition[] = [];
    const starter: TaskStarter = {
      start: (work) => {
        seen.push(work);

        return runningInfo({
          id: taskIdSchema.parse('t1'),
          callId: work.callId,
          agentSessionId: work.agentSessionId,
          command: work.command,
          description: work.description,
          kind: work.backgroundKind,
          startedAt: 0,
        });
      },
    };

    startWork({ tasks: starter, work: serviceWork(input) });

    expect(seen.map((work) => work.backgroundKind)).toEqual(['service']);
  });

  it('starts the work in the registry it is given', async () => {
    const tasks = new TaskRegistry();
    const started = startWork({ tasks, work: finiteWork(input) });

    expect(tasks.get(started.id)?.status).toBe('running');
    await tasks.cancelAll();
  });
});

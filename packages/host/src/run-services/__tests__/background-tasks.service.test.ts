import { describe, expect, it } from 'vitest';
import { ExtensionUndeclaredError } from '@sheavly/extension/errors/manifest.errors';
import { ScopeDeactivatedError } from '@sheavly/extension/errors/scopes.errors';
import {
  BACKGROUND_TASKS,
  CHILD_SESSIONS,
} from '@sheavly/extension/run-services/run-services.utils';
import { callIdSchema } from '@sheavly/protocol/message/message.validator';
import type { SessionId } from '@sheavly/protocol/session/session.types';
import { sessionIdSchema } from '@sheavly/protocol/session/session.validator';
import { taskIdSchema } from '@sheavly/protocol/task/task.validator';
import { SessionError } from '@sheavly/runtime/errors/sessions.errors';
import type { TaskId } from '@sheavly/protocol/task/task.types';
import { TaskError } from '@sheavly/runtime/errors/tasks.errors';
import { agentWork, finiteWork } from '@sheavly/runtime/tasks/work.utils';
import { scopeRun } from '../../testing/scope-run.fake.js';
import { waitingWork as waiting } from '../../testing/waiting-work.fake.js';

const unknown = taskIdSchema.parse('t99');
const nowhere = sessionIdSchema.parse('nowhere');
const allGrants = ['task:start', 'task:read', 'task:cancel'];

/** A run with one extension per name, each holding `held`; `scope(name)` is that extension's service. */
async function activated(params: { names: string[]; held?: string[] }) {
  const { names, held = allGrants } = params;
  const run = scopeRun();
  const { deactivate } = await run.activate(
    names.map((name) => ({ name, requires: [BACKGROUND_TASKS.name], grants: held })),
  );

  return {
    run,
    deactivate,
    main: run.harness.mainSession.id,
    scope: (name: string) => run.servicesOf(name).get(BACKGROUND_TASKS),
  };
}

/**
 * Starts a sub-agent's work through `tasks`, naming the session `agent` as the one it runs, and
 * says how many nodes that opened: none when the task took its session's own node.
 */
async function startAgentTask(params: {
  run: Awaited<ReturnType<typeof activated>>['run'];
  tasks: ReturnType<Awaited<ReturnType<typeof activated>>['scope']>;
  agent: SessionId;
}) {
  const { run, tasks, agent } = params;
  const before = run.harness.nodes.list().length;
  const task = tasks.start({
    ...agentWork({
      command: 'wait',
      description: 'waits',
      sessionId: run.harness.mainSession.id,
      run: ({ signal }) =>
        new Promise((resolve) => signal.addEventListener('abort', () => resolve({ exitCode: 1 }))),
    }),
    agentSessionId: agent,
  });
  const opened = run.harness.nodes.list().length - before;

  await run.harness.tasks.cancelAll();

  return { task, opened };
}

describe('the background-tasks service', () => {
  it('starts work for the main session, owns the task and reads and cancels it', async () => {
    const { main, scope } = await activated({ names: ['a'] });
    const tasks = scope('a');
    const started = tasks.start(waiting(main));

    expect(tasks.get(started.id)?.status).toBe('running');
    expect(tasks.list().map((task) => task.id)).toEqual([started.id]);
    expect(tasks.report(started.id)).toBeUndefined();
    await expect(tasks.cancel(started.id)).resolves.toMatchObject({ status: 'cancelled' });
  });

  it('drops a session an extension names but did not start: it cannot take another’s child', async () => {
    const { run, main, scope } = await activated({ names: ['a'] });
    // A sub-agent some other code started under the main session, which the extension did not.
    const theirs = run.harness.sessions.startChild({
      parentId: main,
      startedByCall: callIdSchema.parse('theirs'),
      title: 'theirs',
    });
    const { task, opened } = await startAgentTask({ run, tasks: scope('a'), agent: theirs.id });

    // The task has a node of its own and runs no session, so nothing of the session is taken or,
    // later, released along with the task.
    expect(opened).toBe(1);
    expect(run.harness.tasks.agentSessionOf(task.id)).toBeUndefined();
  });

  it('keeps the session its own extension started: how the harness’s sub-agent tool pairs a task with its child', async () => {
    const run = scopeRun();

    await run.activate([
      {
        name: 'agents',
        requires: [BACKGROUND_TASKS.name, CHILD_SESSIONS.name],
        grants: [...allGrants, 'sub-agent:create'],
      },
    ]);

    const mine = run
      .servicesOf('agents')
      .get(CHILD_SESSIONS)
      .startChild({
        parentId: run.harness.mainSession.id,
        startedByCall: callIdSchema.parse('mine'),
        title: 'mine',
      });
    const { task, opened } = await startAgentTask({
      run,
      tasks: run.servicesOf('agents').get(BACKGROUND_TASKS),
      agent: mine.id,
    });

    // One sub-agent is one node: the task took its session's node and opened none.
    expect(opened).toBe(0);
    expect(run.harness.tasks.agentSessionOf(task.id)).toBe(mine.id);
  });

  it('refuses each verb without its grant, naming the extension and the grant', async () => {
    const { main, scope } = await activated({ names: ['none'], held: [] });
    const tasks = scope('none');
    const verbs: [string, () => unknown][] = [
      ['task:start', () => tasks.start(waiting(main))],
      ['task:read', () => tasks.get(unknown)],
      ['task:read', () => tasks.report(unknown)],
      ['task:read', () => tasks.list()],
      ['task:read', () => tasks.observe(() => undefined)],
      ['task:cancel', () => tasks.group({ ids: [], reason: 'r', sessionId: main })],
    ];

    for (const [grant, verb] of verbs) {
      expect(verb).toThrow(ExtensionUndeclaredError);
      expect(verb).toThrow(new RegExp(grant));
    }

    await expect(tasks.cancel(unknown)).rejects.toThrow(/task:cancel/);
  });

  it('treats another extension’s task as unknown for every verb', async () => {
    const { run, main, scope } = await activated({ names: ['a', 'b'] });
    const mine = scope('a').start(waiting(main));
    const theirs = scope('b').start(waiting(main));
    const a = scope('a');
    const groupTheirs = () => a.group({ ids: [theirs.id], reason: 'r', sessionId: main });

    expect(a.get(theirs.id)).toBeUndefined();
    expect(a.report(theirs.id)).toBeUndefined();
    expect(a.list().map((task) => task.id)).toEqual([mine.id]);
    await expect(a.cancel(theirs.id)).resolves.toBeUndefined();
    expect(run.harness.tasks.get(theirs.id)?.status).toBe('running');
    expect(groupTheirs).toThrow(TaskError);
    expect(groupTheirs).toThrow(/unknown|Unknown|No task/i);
    await run.harness.tasks.cancelAll();
  });

  it('groups owned tasks through the registry', async () => {
    const { run, main, scope } = await activated({ names: ['a'] });
    const tasks = scope('a');
    const first = tasks.start(waiting(main));

    tasks.group({ ids: [first.id], reason: 'together', sessionId: main });

    expect(tasks.get(first.id)?.reason).toBe('together');
    await run.harness.tasks.cancelAll();
  });

  it('observes the start and end of its own tasks only, hearing the start of the one it is starting', async () => {
    const { main, scope } = await activated({ names: ['a', 'b'] });
    const heard: string[] = [];

    scope('a').observe(({ update }) => heard.push(`${update.type}:${update.task.id}`));

    const theirs = scope('b').start(waiting(main));
    const mine = scope('a').start(waiting(main));

    await scope('a').cancel(mine.id);
    await scope('b').cancel(theirs.id);

    expect(heard).toEqual([`task_started:${mine.id}`, `task_ended:${mine.id}`]);
  });

  it('does not own a task another extension starts while its own start is running', async () => {
    const { run, main, scope } = await activated({ names: ['a', 'b'] });
    const heard: string[] = [];
    let nested: TaskId | undefined;

    scope('a').observe(({ update }) => heard.push(update.task.id));

    // The registry runs the work during `start`, so b's start happens inside a's.
    const mine = scope('a').start(
      finiteWork({
        command: 'outer',
        description: 'starts another extension’s task',
        sessionId: main,
        run: ({ signal }) => {
          nested = scope('b').start(waiting(main)).id;

          return new Promise((resolve) =>
            signal.addEventListener('abort', () => resolve({ exitCode: 1 })),
          );
        },
      }),
    );

    expect(nested).toBeDefined();
    expect(scope('a').get(mine.id)).toBeDefined();
    expect(scope('a').get(nested ?? unknown)).toBeUndefined();
    expect(
      scope('a')
        .list()
        .map((task) => task.id),
    ).toEqual([mine.id]);
    await expect(scope('a').cancel(nested ?? unknown)).resolves.toBeUndefined();
    expect(heard).toEqual([mine.id]);
    await run.harness.tasks.cancelAll();
  });

  it('returns the id from start when an observer throws, and still tells the other observers', async () => {
    const { run, main, scope } = await activated({ names: ['a'] });
    const heard: string[] = [];
    const uncaught: unknown[] = [];
    const onUncaught = (error: unknown) => uncaught.push(error);

    process.on('uncaughtException', onUncaught);
    scope('a').observe(() => {
      throw new Error('broken observer');
    });
    scope('a').observe(({ update }) => heard.push(update.type));

    const started = scope('a').start(waiting(main));

    expect(scope('a').get(started.id)?.status).toBe('running');
    expect(heard).toEqual(['task_started']);
    // The end of the task is heard by the same observers, so it is reported too.
    await run.harness.tasks.cancelAll();
    await new Promise((resolve) => setTimeout(resolve, 0));
    process.off('uncaughtException', onUncaught);
    expect(uncaught).toEqual([new Error('broken observer'), new Error('broken observer')]);
    expect(heard).toEqual(['task_started', 'task_ended']);
  });

  it('delivers what a nested start causes after the events already queued, in the order heard', async () => {
    const { run, main, scope } = await activated({ names: ['a'] });
    const tasks = scope('a');
    const heard: string[] = [];
    let nested: TaskId | undefined;

    tasks.observe(({ update }) => {
      heard.push(`${update.type}:${update.task.id}`);

      if (nested !== undefined || update.type !== 'task_started') return;

      nested = tasks.start(waiting(main)).id;
      heard.push('nested-returned');
    });

    const first = tasks.start(waiting(main));

    await run.harness.tasks.cancelAll();

    expect(heard).toEqual([
      `task_started:${first.id}`,
      'nested-returned',
      `task_started:${nested}`,
      `task_ended:${first.id}`,
      `task_ended:${nested}`,
    ]);
  });

  it('refuses work for a session that is not open in the run', async () => {
    const run = scopeRun();
    const { sessions, mainSession } = run.harness;
    const ended = sessions.startChild({
      parentId: mainSession.id,
      startedByCall: callIdSchema.parse('c1'),
      title: 'done',
    });

    sessions.end({ id: ended.id, state: 'completed' });
    await run.activate([{ name: 'a', requires: [BACKGROUND_TASKS.name], grants: allGrants }]);

    const tasks = run.servicesOf('a').get(BACKGROUND_TASKS);

    expect(() => tasks.start(waiting(ended.id))).toThrow(/has ended/);
    expect(() => tasks.start(waiting(nowhere))).toThrow(SessionError);
    expect(() => tasks.start(waiting(nowhere))).toThrow(/Unknown session/);
    expect(run.harness.tasks.list()).toEqual([]);
  });

  it('has no member that starts outside its policy, cancels in bulk or consumes deliveries', async () => {
    const { scope } = await activated({ names: ['a'] });
    const tasks = scope('a');

    for (const name of [
      'cancelAll',
      'cancelSession',
      'takeDeliveries',
      'hasDeliveries',
      'release',
      'releaseFinished',
      'getOwned',
      'runningTasks',
      'registry',
    ]) {
      expect(name in tasks).toBe(false);
    }

    expect(Object.isFrozen(tasks)).toBe(true);
  });

  it('throws deactivated after the host stops the extension, and stops its observers', async () => {
    const { run, main, scope, deactivate } = await activated({ names: ['a'] });
    const tasks = scope('a');
    const heard: unknown[] = [];

    tasks.observe((event) => heard.push(event));
    await deactivate();

    expect(() => tasks.start(waiting(main))).toThrow(ScopeDeactivatedError);
    expect(() => tasks.list()).toThrow(ScopeDeactivatedError);

    run.harness.tasks.start(waiting(main));

    expect(heard).toEqual([]);
    await run.harness.tasks.cancelAll();
  });
});

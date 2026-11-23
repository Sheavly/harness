import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { ExtensionUndeclaredError } from '@sheavly/extension/errors/manifest.errors';
import type { RunChildParams } from '@sheavly/extension/run-services/run-services.types';
import { CHILD_SESSIONS } from '@sheavly/extension/run-services/run-services.utils';
import type { HistoryMessage } from '@sheavly/protocol/history/history.types';
import { callIdSchema, messageIdSchema } from '@sheavly/protocol/message/message.validator';
import { runSession } from '@sheavly/loop/stream-agent/stream-agent.helper';
import { SessionError } from '@sheavly/runtime/errors/sessions.errors';
import { startWork } from '@sheavly/runtime/tasks/work.utils';
import { routedProvider, say } from '@sheavly/testing/provider/routed-provider.fake';
import { ChildRunningError } from '../../errors/scopes.errors.js';
import { scopeRun } from '../../testing/scope-run.fake.js';
import { waitingWork } from '../../testing/waiting-work.fake.js';
import type { RunLoop } from '../run-services.types.js';

const call = (id: string) => callIdSchema.parse(id);
const owner = (name: string, grants = ['sub-agent:create']) => ({
  name,
  requires: [CHILD_SESSIONS.name],
  grants,
});
const prompt = (content: string): HistoryMessage[] => [
  { role: 'user', id: messageIdSchema.parse(randomUUID()), content, at: 1 },
];

/** The params of a run: everything but the child, which each test chooses. */
function params(overrides: Partial<RunChildParams> = {}): Omit<RunChildParams, 'child'> {
  return {
    provider: routedProvider({ go: [say('done')] }),
    tools: [],
    hooks: [],
    instructions: 'be brief',
    messages: prompt('go'),
    signal: new AbortController().signal,
    ...overrides,
  };
}

const failingRunEnd = () => {
  throw new Error('end failed');
};

/** A run whose loop is `loop`, with one extension `a` that has started a child under the main session. */
async function withChild(loop: RunLoop) {
  const run = scopeRun({ runSession: loop });

  await run.activate([owner('a')]);

  const scope = run.servicesOf('a').get(CHILD_SESSIONS);
  const main = run.harness.mainSession;
  const child = scope.startChild({ parentId: main.id, startedByCall: call('c1'), title: 'child' });

  return { run, scope, main, child };
}

/** `withChild`, whose loop leaves a task of the child running and returns completed. */
async function withWaitingChild() {
  const started: Awaited<ReturnType<typeof withChild>> = await withChild(async (options) => {
    startWork({ tasks: started.run.harness.tasks, work: waitingWork(started.child.id) });

    return { reason: 'completed', messages: options.messages };
  });

  return started;
}

describe('the child-sessions service: runChild', () => {
  it('runs the real loop on the child it started and keeps the history before and after', async () => {
    const { run, scope, child } = await withChild(runSession);
    const kept: number[] = [];
    const result = await scope.runChild({
      ...params({ keepHistory: (messages) => kept.push(messages.length) }),
      child,
    });

    expect(result.reason).toBe('completed');
    expect(result.messages.at(-1)).toMatchObject({ role: 'assistant', content: 'done' });
    expect(kept[0]).toBe(1);
    expect(kept.at(-1)).toBe(result.messages.length);
    expect(run.harness.sessions.get(child.id)?.state).toBe('completed');
  });

  it('gives the loop the run’s full registries, never the extension, and stops the child’s tasks after', async () => {
    const seen: Parameters<RunLoop>[0][] = [];
    const { run, scope, child } = await withChild(async (options) => {
      seen.push(options);
      startWork({
        tasks: run.harness.tasks,
        work: waitingWork(options.session?.ref.id ?? run.harness.mainSession.id),
      });

      return { reason: 'completed', messages: options.messages };
    });

    await scope.runChild({ ...params(), child });

    expect(seen[0]?.tasks).toBe(run.harness.tasks);
    expect(seen[0]?.session?.registry).toBe(run.harness.sessions);
    expect(seen[0]?.session?.ref).toEqual(child);
    expect(run.harness.tasks.list().map((task) => task.status)).toEqual(['cancelled']);
  });

  it('stops the child’s tasks even when the loop throws, and leaves the parent’s alone', async () => {
    const { run, scope, main, child } = await withChild(() =>
      Promise.reject(new Error('loop failed')),
    );
    const own = startWork({ tasks: run.harness.tasks, work: waitingWork(child.id) });
    const parents = startWork({ tasks: run.harness.tasks, work: waitingWork(main.id) });

    await expect(scope.runChild({ ...params(), child })).rejects.toThrow('loop failed');

    expect(run.harness.tasks.get(own.id)?.status).toBe('cancelled');
    expect(run.harness.tasks.get(parents.id)?.status).toBe('running');
    await run.harness.tasks.cancelAll();
  });

  it('ends the child as failed when the loop throws before it ended the session, so it can be released', async () => {
    const { run, scope, child } = await withChild(() => Promise.reject(new Error('loop failed')));

    await expect(scope.runChild({ ...params(), child })).rejects.toThrow('loop failed');

    expect(run.harness.sessions.get(child.id)).toMatchObject({ state: 'failed' });
    expect(run.harness.sessions.releaseAgent(child.id)).toBe(true);
    expect(run.harness.nodes.list().map((node) => node.kind)).toEqual(['agent']);
  });

  it('keeps the outcome the loop gave the session when it threw after ending it', async () => {
    const { run, scope, child } = await withChild(() => {
      run.harness.sessions.end({ id: child.id, state: 'max_turns' });

      return Promise.reject(new Error('loop failed late'));
    });

    await expect(scope.runChild({ ...params(), child })).rejects.toThrow('loop failed late');

    expect(run.harness.sessions.get(child.id)?.state).toBe('max_turns');
  });

  it('refuses a session the scope did not start, and runs nothing', async () => {
    const seen: unknown[] = [];
    const run = scopeRun({
      runSession: async (options) => {
        seen.push(options);

        return { reason: 'completed', messages: [] };
      },
    });

    await run.activate([owner('a'), owner('b')]);

    const other = run
      .servicesOf('b')
      .get(CHILD_SESSIONS)
      .startChild({
        parentId: run.harness.mainSession.id,
        startedByCall: call('cb'),
        title: 'b',
      });
    const scope = run.servicesOf('a').get(CHILD_SESSIONS);

    await expect(scope.runChild({ ...params(), child: other })).rejects.toThrow(SessionError);
    await expect(scope.runChild({ ...params(), child: run.harness.mainSession })).rejects.toThrow(
      /Unknown session/,
    );
    expect(seen).toEqual([]);
  });

  it('runs as the child it started even when the caller changes the ref it was given', async () => {
    const seen: Parameters<RunLoop>[0][] = [];
    const { run, scope, main, child } = await withChild(async (options) => {
      seen.push(options);

      return { reason: 'completed', messages: options.messages };
    });
    const forged = child as { id: string };

    expect(() => {
      forged.id = main.id;
    }).toThrow(TypeError);

    await scope.runChild({ ...params(), child });

    expect(seen[0]?.session?.ref.id).toBe(child.id);
    expect(seen[0]?.session?.ref).not.toBe(child);
    expect(run.harness.sessions.get(main.id)?.state).not.toBe('completed');
  });

  it('refuses a forged ref naming another session, runs nothing and cancels nothing', async () => {
    const seen: unknown[] = [];
    const { run, scope, main, child } = await withChild(async (options) => {
      seen.push(options);

      return { reason: 'completed', messages: [] };
    });
    const parents = startWork({ tasks: run.harness.tasks, work: waitingWork(main.id) });

    await expect(scope.runChild({ ...params(), child: { ...child, id: main.id } })).rejects.toThrow(
      /Unknown session/,
    );
    expect(seen).toEqual([]);
    expect(run.harness.tasks.get(parents.id)?.status).toBe('running');
    await run.harness.tasks.cancelAll();
  });

  it('refuses a child that has ended, and runs nothing', async () => {
    const seen: unknown[] = [];
    const { run, scope, child } = await withChild(async (options) => {
      seen.push(options);

      return { reason: 'completed', messages: [] };
    });

    run.harness.sessions.end({ id: child.id, state: 'completed' });

    await expect(scope.runChild({ ...params(), child })).rejects.toThrow(/has ended/);
    expect(seen).toEqual([]);
  });

  it('refuses a second run on a child already running, and allows one after it ends', async () => {
    let release: () => void = () => undefined;
    let runs = 0;
    const { scope, child } = await withChild(async (options) => {
      runs += 1;
      await new Promise<void>((resolve) => {
        release = resolve;
      });

      return { reason: 'completed', messages: options.messages };
    });
    const first = scope.runChild({ ...params(), child });

    await expect(scope.runChild({ ...params(), child })).rejects.toThrow(ChildRunningError);
    expect(runs).toBe(1);
    release();
    await first;

    // The flag is cleared however the run ends.
    const second = scope.runChild({ ...params(), child });

    release();
    await expect(second).resolves.toMatchObject({ reason: 'completed' });
    expect(runs).toBe(2);
  });

  it('tells the caller the run ended before it cancels the child’s tasks', async () => {
    const order: string[] = [];
    const { run, scope, child } = await withWaitingChild();

    run.harness.tasks.observe(({ update }) => {
      if (update.type !== 'task_started') order.push(`task:${update.type}`);
    });
    await scope.runChild({ ...params({ onRunEnd: () => order.push('run-end') }), child });

    expect(order[0]).toBe('run-end');
    expect(order.length).toBeGreaterThan(1);
  });

  it('stops the child’s tasks and clears the running flag when onRunEnd throws, surfacing its error', async () => {
    const { run, scope, child } = await withWaitingChild();

    await expect(scope.runChild({ ...params({ onRunEnd: failingRunEnd }), child })).rejects.toThrow(
      'end failed',
    );

    expect(run.harness.tasks.list().map((task) => task.status)).toEqual(['cancelled']);
    await expect(scope.runChild({ ...params(), child })).resolves.toMatchObject({
      reason: 'completed',
    });
    await run.harness.tasks.cancelAll();
  });

  it('keeps the run’s own error when onRunEnd throws too, and still stops the child’s tasks', async () => {
    const { run, scope, child } = await withChild(() => {
      startWork({ tasks: run.harness.tasks, work: waitingWork(child.id) });

      return Promise.reject(new Error('loop failed'));
    });

    await expect(scope.runChild({ ...params({ onRunEnd: failingRunEnd }), child })).rejects.toThrow(
      'loop failed',
    );

    expect(run.harness.tasks.list().map((task) => task.status)).toEqual(['cancelled']);
    await run.harness.tasks.cancelAll();
  });

  it('needs sub-agent:create', async () => {
    const run = scopeRun();

    await run.activate([owner('none', [])]);

    const scope = run.servicesOf('none').get(CHILD_SESSIONS);

    await expect(scope.runChild({ ...params(), child: run.harness.mainSession })).rejects.toThrow(
      ExtensionUndeclaredError,
    );
  });
});

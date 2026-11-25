import { afterEach, describe, expect, it, vi } from 'vitest';
import { runTool } from '@sheavly/core/tool/tool.helper';
import { callIdSchema } from '@sheavly/protocol/message/message.validator';
import { sessionRefSchema } from '@sheavly/protocol/session/session.validator';
import { taskIdSchema } from '@sheavly/protocol/task/task.validator';
import { SessionRegistry } from '@sheavly/runtime/sessions/sessions.service';
import { TaskRegistry } from '@sheavly/runtime/tasks/tasks.service';
import { startTaskTool } from '@sheavly/runtime/testing/start-task.fake';
import { toolRunner } from '@sheavly/testing/tool/tool-runner.fake';
import { createTaskTools } from '../tasks.tool.js';

let tasks: TaskRegistry;

/** The tools, called as one session: the task tools refuse a call that has none. */
function setup() {
  tasks = new TaskRegistry();

  const session = new SessionRegistry().startMain({ title: 'Main' });

  return toolRunner([startTaskTool(tasks), ...createTaskTools(tasks)], session);
}

afterEach(async () => {
  await tasks.cancelAll();
  vi.restoreAllMocks();
});

describe('await_tasks', () => {
  it('registers a group immediately without waiting for its running members', async () => {
    const run = setup();

    await run('start1', 'start_task', { ms: 5_000 });
    await run('start2', 'start_task', { ms: 5_000 });
    const group = vi.spyOn(tasks, 'group');
    const nextSettled = vi.spyOn(tasks, 'nextSettled');
    const started = performance.now();
    const result = await run('group', 'await_tasks', {
      ids: ['t1', 't2'],
      reason: '  Compare lint and tests before deciding whether the patch is ready.  ',
    });

    expect(performance.now() - started).toBeLessThan(500);
    expect(result).toMatchObject({ isError: false });
    expect(group).toHaveBeenCalledOnce();
    expect(group.mock.calls[0]?.[0]).toMatchObject({
      ids: [taskIdSchema.parse('t1'), taskIdSchema.parse('t2')],
      reason: 'Compare lint and tests before deciding whether the patch is ready.',
    });
    expect(nextSettled).not.toHaveBeenCalled();
    expect(tasks.runningCount).toBe(2);
    expect(result.content).toBe(
      'Grouped tasks t1, t2. Their results will be delivered together when all members finish.\n' +
        'Reason: Compare lint and tests before deciding whether the patch is ready.\n' +
        'Finish independent work, then end your turn without tool calls; the grouped results wake you once every member has finished. Do not poll task_status.',
    );
  });

  it('passes the calling session id to the registry', async () => {
    setup();
    const group = vi.spyOn(tasks, 'group');
    const session = sessionRefSchema.parse({ id: 'main', rootId: 'main', depth: 1 });

    // Started by the session that then groups it: another session's task cannot be grouped.
    tasks.start({
      command: 'check',
      description: 'Verify the patch',
      sessionId: session.id,
      run: async () => ({ exitCode: 0 }),
    });

    const result = await runTool({
      tools: createTaskTools(tasks),
      call: {
        id: callIdSchema.parse('group'),
        name: 'await_tasks',
        input: { description: 'Group checks', ids: ['t1'], reason: 'Use tests to verify the fix.' },
      },
      signal: new AbortController().signal,
      session,
    });

    expect(result.isError).toBe(false);
    expect(group).toHaveBeenCalledExactlyOnceWith({
      ids: [taskIdSchema.parse('t1')],
      reason: 'Use tests to verify the fix.',
      sessionId: session.id,
    });
  });

  it("returns an error for another session's task without grouping it", async () => {
    setup();
    const owner = sessionRefSchema.parse({ id: 'owner', rootId: 'owner', depth: 1 });
    const other = sessionRefSchema.parse({ id: 'other', rootId: 'other', depth: 1 });

    tasks.start({
      command: 'check',
      description: 'Verify the patch',
      sessionId: owner.id,
      run: async () => ({ exitCode: 0 }),
    });
    const call = {
      id: callIdSchema.parse('group'),
      name: 'await_tasks',
      input: { description: 'Group checks', ids: ['t1'], reason: 'Use tests to verify the fix.' },
    };
    const tools = createTaskTools(tasks);
    const signal = new AbortController().signal;

    expect(await runTool({ tools, call, signal, session: other })).toMatchObject({ isError: true });
    expect(await runTool({ tools, call, signal, session: owner })).toMatchObject({
      isError: false,
    });
  });

  it('returns an error result for a task whose notice was already delivered', async () => {
    const run = setup();

    await run('start', 'start_task', { ms: 0 });
    await tasks.nextSettled();
    expect(tasks.takeDeliveries()).toHaveLength(1);

    const result = await run('late', 'await_tasks', { ids: ['t1'], reason: 'Too late.' });

    expect(result).toMatchObject({ isError: true });
    expect(result.content).toContain('Task t1 was already reported and cannot be grouped');
    expect(tasks.hasDeliveries()).toBe(false);
  });

  it.each([undefined, '', '   ', '\n\t', 42])('requires a nonempty reason: %s', async (reason) => {
    const run = setup();
    const group = vi.spyOn(tasks, 'group');
    const result = await run('invalid', 'await_tasks', { ids: ['t1'], reason });

    expect(result.isError).toBe(true);
    expect(group).not.toHaveBeenCalled();
  });

  it('requires at least one task id', async () => {
    const run = setup();
    const group = vi.spyOn(tasks, 'group');
    const result = await run('empty', 'await_tasks', { ids: [], reason: 'Verify the patch.' });

    expect(result.isError).toBe(true);
    expect(group).not.toHaveBeenCalled();
  });

  it.each([
    ['t1', 'missing'],
    ['t1', 't1'],
  ])('returns a registry error for invalid ids atomically: %s', async (...ids) => {
    const run = setup();

    await run('start', 'start_task', { ms: 5_000 });
    expect(await run('invalid', 'await_tasks', { ids, reason: 'Verify the patch.' })).toMatchObject(
      {
        isError: true,
      },
    );
    expect(
      await run('valid', 'await_tasks', { ids: ['t1'], reason: 'Verify the patch.' }),
    ).toMatchObject({
      isError: false,
    });
  });

  it('rejects already grouped ids without claiming any other member', async () => {
    const run = setup();

    await run('start1', 'start_task', { ms: 5_000 });
    await run('start2', 'start_task', { ms: 5_000 });
    expect(
      await run('first', 'await_tasks', { ids: ['t1'], reason: 'Review the first check.' }),
    ).toMatchObject({ isError: false });
    expect(
      await run('overlap', 'await_tasks', { ids: ['t2', 't1'], reason: 'Review both checks.' }),
    ).toMatchObject({ isError: true });
    expect(
      await run('second', 'await_tasks', { ids: ['t2'], reason: 'Review the second check.' }),
    ).toMatchObject({ isError: false });
  });

  it('delegates cancellation of a grouped member to the registry', async () => {
    const run = setup();

    await run('start1', 'start_task', { ms: 5_000 });
    await run('start2', 'start_task', { ms: 5_000 });
    await run('group', 'await_tasks', {
      ids: ['t1', 't2'],
      reason: 'Use the checks to verify the fix.',
    });
    const cancel = vi.spyOn(tasks, 'cancel');
    const result = await run('cancel', 'cancel_task', { id: 't1' });

    expect(result.isError).toBe(false);
    expect(cancel).toHaveBeenCalledExactlyOnceWith(taskIdSchema.parse('t1'));
    expect(tasks.takeDeliveries()).toEqual([]);
    await run('cancel2', 'cancel_task', { id: 't2' });
    expect(tasks.takeDeliveries()).toEqual([
      {
        reason: 'Use the checks to verify the fix.',
        tasks: [
          expect.objectContaining({ id: 't1', status: 'cancelled' }),
          expect.objectContaining({ id: 't2', status: 'cancelled' }),
        ],
      },
    ]);
  });

  it('says results arrive without it, so one task never needs a group', () => {
    setup();
    const tool = createTaskTools(tasks).find((candidate) => candidate.name === 'await_tasks')!;

    expect(tool.description.startsWith('Optional, and rarely needed:')).toBe(true);
    expect(tool.description).toContain('finite background task is delivered to you automatically');
    expect(tool.description).toContain('never call this for one task or just to wait');
    expect(tool.description).toContain('two or more results must reach you together');
  });

  it('guides useful reasons without policing their wording', () => {
    setup();
    const tool = createTaskTools(tasks).find((candidate) => candidate.name === 'await_tasks')!;

    expect(tool.description).toContain('future self');
    expect(tool.description).toContain('after a summary');
    expect(tool.description).toContain('Do not use a generic reason');
    expect(tool.inputSchema.parse({ ids: ['t1'], reason: 'waiting for results' })).toMatchObject({
      reason: 'waiting for results',
    });
  });
});

import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Provider } from '@sheavly/core/provider/provider.types';
import { runTool } from '@sheavly/core/tool/tool.helper';
import { callIdSchema } from '@sheavly/protocol/message/message.validator';
import { taskIdSchema } from '@sheavly/protocol/task/task.validator';
import { SessionRegistry } from '@sheavly/runtime/sessions/sessions.service';
import { TaskRegistry } from '@sheavly/runtime/tasks/tasks.service';
import { registryScopes } from '../../testing/registry-scopes.fake.js';
import type { RunWithRegistries } from '../../testing/registry-scopes.types.js';
import { createSubAgentTool } from '../sub-agent.tool.js';

let tasks: TaskRegistry;

afterEach(async () => {
  await tasks.cancelAll();
});

describe('start_agent history keeping', () => {
  const provider: Provider = {
    async *stream() {
      yield { type: 'done', stopReason: 'end_turn' };
    },
  };

  async function startWith(params: { runAgent: RunWithRegistries; keepHistory: () => void }) {
    tasks = new TaskRegistry();
    const sessions = new SessionRegistry();
    const parent = sessions.startMain({ title: 'Main' });
    const kept: { session: string; count: number }[] = [];

    await runTool({
      tools: [
        createSubAgentTool({
          scopes: registryScopes({ sessions, tasks, runAgent: params.runAgent }),
          provider,
          tools: [],
          keepHistory: (call) => {
            params.keepHistory();
            kept.push({ session: call.session, count: call.messages.length });
          },
        }),
      ],
      call: {
        id: callIdSchema.parse('child'),
        name: 'start_agent',
        input: { description: 'd', title: 'Review', task: 'Review the patch.' },
      },
      signal: new AbortController().signal,
      session: parent,
    });
    await tasks.nextSettled();

    return kept;
  }

  it('keeps the task before the run and the whole history after it', async () => {
    const order: string[] = [];
    const runAgent = vi.fn<RunWithRegistries>(async ({ messages }) => {
      order.push('run');

      return {
        reason: 'completed',
        messages: [...messages, { role: 'assistant', content: 'done', toolCalls: [] }],
      };
    });
    const kept = await startWith({ runAgent, keepHistory: () => order.push('keep') });

    expect(order).toEqual(['keep', 'run', 'keep']);
    expect(kept.map((each) => each.count)).toEqual([1, 2]);
    expect(new Set(kept.map((each) => each.session)).size).toBe(1);
  });

  it('keeps the work of a run that did not complete', async () => {
    const runAgent = vi.fn<RunWithRegistries>(async ({ messages }) => ({
      reason: 'interrupted',
      messages: [...messages, { role: 'assistant', content: 'half', toolCalls: [] }],
    }));
    const kept = await startWith({ runAgent, keepHistory: () => undefined });

    expect(kept.map((each) => each.count)).toEqual([1, 2]);
  });
});

describe('start_agent task lifecycle', () => {
  it('starts finite work by default and gives the child all task tools', async () => {
    tasks = new TaskRegistry();
    const sessions = new SessionRegistry();
    const parent = sessions.startMain({ title: 'Main' });
    const finish = Promise.withResolvers<Awaited<ReturnType<RunWithRegistries>>>();
    const runAgent = vi.fn<RunWithRegistries>(({ signal }) => {
      signal.addEventListener('abort', () =>
        finish.resolve({ reason: 'interrupted', messages: [] }),
      );

      return finish.promise;
    });
    const provider: Provider = {
      async *stream() {
        yield { type: 'done', stopReason: 'end_turn' };
      },
    };
    const start = vi.spyOn(tasks, 'start');
    const result = await runTool({
      tools: [
        createSubAgentTool({
          scopes: registryScopes({ sessions, tasks, runAgent }),
          provider,
          tools: [],
        }),
      ],
      call: {
        id: callIdSchema.parse('child'),
        name: 'start_agent',
        input: { description: 'Review the patch', title: 'Review', task: 'Review the patch.' },
      },
      signal: new AbortController().signal,
      session: parent,
    });

    expect(result.isError).toBe(false);
    const child = runAgent.mock.calls[0]![0].session.ref;

    expect(result.content).toBe(
      `Started sub-agent "Review" as background task t1 (session ${child.id}, depth ${child.depth}). Its complete report comes to you automatically: ` +
        "don't poll task_status for it, and don't call await_tasks for it alone; once you have nothing else to do, end your turn and you will be woken. " +
        'Use message_agent with its session id to steer it, cancel_task to stop it.',
    );
    expect(tasks.hasPendingTasks(parent.id)).toBe(true);
    expect(start.mock.calls[0]?.[0]).toMatchObject({
      command: 'sub-agent: Review',
      description: 'Review the patch',
      callId: 'child',
      sessionId: parent.id,
      backgroundKind: 'agent',
    });
    const childOptions = runAgent.mock.calls[0]![0];

    expect(childOptions.tools.map((tool) => tool.name)).toEqual([
      'report_status',
      'task_status',
      'cancel_task',
      'await_tasks',
      'start_agent',
      'message_agent',
    ]);
    expect(Object.keys(childOptions).sort()).toEqual([
      'child',
      'hooks',
      'instructions',
      'messages',
      'onRunEnd',
      'provider',
      'session',
      'signal',
      'tasks',
      'tools',
    ]);
    finish.resolve({ reason: 'completed', messages: [] });
    await tasks.nextSettled();
    expect(tasks.get(taskIdSchema.parse('t1'))?.status).toBe('completed');
    expect(tasks.takeDeliveries(parent.id)).toHaveLength(1);
    expect(tasks.hasPendingTasks(parent.id)).toBe(false);
  });
});

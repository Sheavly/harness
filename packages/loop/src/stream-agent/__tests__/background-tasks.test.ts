import { afterEach, describe, expect, it } from 'vitest';
import { TaskRegistry } from '@sheavly/runtime/tasks/tasks.service';
import { SessionRegistry } from '@sheavly/runtime/sessions/sessions.service';
import { startTaskTool } from '@sheavly/runtime/testing/start-task.fake';
import { createTaskTools } from '@sheavly/tools/tasks/tasks.tool';
import type { StreamEvent } from '@sheavly/core/message/message.types';
import type { Provider } from '@sheavly/core/provider/provider.types';
import { streamAgent } from '../stream-agent.helper.js';
import type { AgentOptions } from '../stream-agent.types.js';
import type { AgentEvent } from '@sheavly/protocol/event/event.types';
import type { Message } from '@sheavly/protocol/message/message.types';
import { callIdSchema } from '@sheavly/protocol/message/message.validator';
import { taskIdSchema } from '@sheavly/protocol/task/task.validator';
import { until } from '@sheavly/testing/wait/until.fake';

const t1 = taskIdSchema.parse('t1');

let tasks: TaskRegistry;

afterEach(async () => {
  await tasks.cancelAll();
});

const background = (
  id: string,
  ms: number,
  output = '',
  backgroundKind: 'task' | 'service' = 'task',
): StreamEvent => ({
  type: 'tool_call',
  call: {
    id: callIdSchema.parse(id),
    name: 'start_task',
    input: { description: `bg ${id}`, ms, output, backgroundKind },
  },
});
const say = (text: string): StreamEvent[] => [
  { type: 'text_delta', text },
  { type: 'done', stopReason: 'end_turn' },
];

/** Plays back scripted turns and records what the model was sent each time. */
function recordingProvider(turns: StreamEvent[][]) {
  const requests: Message[][] = [];
  const provider: Provider = {
    async *stream({ messages }) {
      requests.push(messages);
      const events = turns[requests.length - 1];

      if (!events) throw new Error('ran out of scripted turns');
      yield* events;
    },
  };

  return { provider, requests };
}

function options(provider: Provider, extra: Partial<AgentOptions> = {}): AgentOptions {
  return {
    provider,
    tools: [startTaskTool(tasks), ...createTaskTools(tasks)],
    messages: [{ role: 'user', content: 'go' }],
    tasks,
    ...extra,
  };
}

async function collect(stream: AsyncIterable<AgentEvent>) {
  const events: AgentEvent[] = [];

  for await (const event of stream) events.push(event);

  return events;
}

const types = (events: AgentEvent[]) => events.map((e) => e.type);
const lastUserMessage = (messages: Message[] | undefined) =>
  messages?.filter((m) => m.role === 'user').at(-1);

describe('background tasks in the loop', () => {
  it("a service doesn't block the turn: it yields task_running and the run ends", async () => {
    tasks = new TaskRegistry();
    const { provider } = recordingProvider([
      [background('c1', 2_000, '', 'service'), { type: 'done', stopReason: 'tool_use' }],
      say('Started it.'),
    ]);

    const started = performance.now();
    const events = await collect(streamAgent(options(provider)));

    expect(performance.now() - started).toBeLessThan(1_000);
    expect(types(events)).toEqual([
      'tool_call_started',
      'usage',
      'turn_end',
      'tool_batch',
      'task_running', // in place of tool_result
      'harness_notice', // live service snapshot, outside history
      'text_delta',
      'usage',
      'turn_end',
      'done',
    ]);
    const running = events.find((event) => event.type === 'task_running');

    expect(running?.type === 'task_running' && running.task).toMatchObject({
      id: 't1',
      callId: 'c1',
      status: 'running',
    });
    // The node the call launched, which the child does not have when the call starts: the node
    // registry's, not the task's counter id.
    const nodeId = tasks.nodeIdOf(t1);

    expect(nodeId).toBeDefined();
    expect(running?.type === 'task_running' && running.nodeId).toBe(nodeId);
    expect(nodeId).not.toBe(t1);
    expect(events.at(-1)).toMatchObject({ type: 'done', reason: 'completed' });
    expect(tasks.get(t1)?.status).toBe('running'); // outlives the run
  });

  it('the completion arrives later through the same ordered queue, and the model is told', async () => {
    tasks = new TaskRegistry();
    const { provider, requests } = recordingProvider([
      [background('c1', 300, 'built'), { type: 'done', stopReason: 'tool_use' }],
      say('Waiting for the build.'),
      say('The build finished.'),
    ]);

    const events = await collect(streamAgent(options(provider)));

    expect(types(events)).toEqual([
      'tool_call_started',
      'usage',
      'turn_end',
      'tool_batch',
      'task_running',
      'harness_notice', // transient running-task snapshot before the call
      'text_delta', // the model kept going while the task ran
      'usage',
      'turn_end',
      'run_state', // held for the task: waiting on none, so ready
      'run_state', // the task finished, so the run works again
      'task_completed', // released at the turn boundary, before the next model call
      'harness_notice', // the same facts as typed data, also stored in history
      'text_delta',
      'usage',
      'turn_end',
      'done',
    ]);
    expect(events.map((e) => e.seq)).toEqual(events.map((_, i) => i));

    const completed = events.find((event) => event.type === 'task_completed');

    expect(completed?.type === 'task_completed' && completed.task).toMatchObject({
      id: 't1',
      status: 'completed',
      exitCode: 0,
    });
    expect(lastUserMessage(requests[2])?.content).toMatch(
      /^<harness-notice kind="task-finished">\n[^\n]*\n\[task t1 · completed · exit code 0/,
    );
    expect(lastUserMessage(requests[2])?.content).toContain('built');

    // The event and the history entry carry the same payload, so a UI and a reload agree.
    const noticeEvent = events.find(
      (event) => event.type === 'harness_notice' && event.notice.kind === 'task-finished',
    );
    const done = events.at(-1);
    const stored =
      done?.type === 'done' ? done.messages.find((m) => m.role === 'notice') : undefined;

    expect(noticeEvent?.type === 'harness_notice' && noticeEvent.notice).toMatchObject({
      kind: 'task-finished',
    });
    expect(stored?.role === 'notice' && stored.notice).toEqual(
      noticeEvent?.type === 'harness_notice' ? noticeEvent.notice : undefined,
    );
  });

  it('repeated status snapshots guide yielding without consuming the required completion', async () => {
    tasks = new TaskRegistry();
    const finish = Promise.withResolvers<undefined>();

    tasks.start({
      command: 'CI',
      description: 'CI',
      run: async ({ onOutput }) => {
        await finish.promise;
        onOutput('CI passed');

        return { exitCode: 0 };
      },
    });
    const status = (id: string): StreamEvent[] => [
      {
        type: 'tool_call',
        call: {
          id: callIdSchema.parse(id),
          name: 'task_status',
          input: { id: 't1', description: 'Wait for CI' },
        },
      },
      { type: 'done', stopReason: 'tool_use' },
    ];
    const { provider, requests } = recordingProvider([
      status('first'),
      status('again'),
      say('Waiting for CI.'),
      say('CI finished.'),
    ]);
    const events: AgentEvent[] = [];

    for await (const event of streamAgent(options(provider))) {
      events.push(event);
      if (event.type === 'turn_end' && event.turn === 3) finish.resolve(undefined);
    }

    for (const messages of requests.slice(1, 3)) {
      expect(messages.at(-1)?.content).toContain('Do not poll');
      expect(messages.at(-1)?.content).toContain('end your turn without tool calls');
    }

    expect(requests).toHaveLength(4);
    expect(lastUserMessage(requests[3])?.content).toContain('CI passed');
    expect(events.filter((event) => event.type === 'task_completed')).toHaveLength(1);
    expect(events.filter((event) => event.type === 'tool_result')).toHaveLength(2);
    expect(events.at(-1)).toMatchObject({ type: 'done', reason: 'completed' });
  });

  it('a service completion after the run is delivered at the start of the next prompt', async () => {
    tasks = new TaskRegistry();
    const registry = new SessionRegistry();
    const ref = registry.startMain({ title: 'Chat' });
    const session = { registry, ref };
    const first = recordingProvider([
      [background('c1', 0, 'quick', 'service'), { type: 'done', stopReason: 'tool_use' }],
      say('Ok.'),
    ]);
    const firstEvents = await collect(
      streamAgent(options(first.provider, { session, keepSession: true })),
    );
    const done = firstEvents.at(-1);

    await until(() => tasks.runningCount === 0);
    registry.resume(ref.id);

    const second = recordingProvider([say('I saw it finish.')]);
    const history = done?.type === 'done' ? done.messages : [];
    const events = await collect(
      streamAgent(
        options(second.provider, {
          session,
          resumed: true,
          messages: [...history, { role: 'user', content: 'status?' }],
        }),
      ),
    );

    expect(types(events)).toEqual([
      'task_completed',
      'harness_notice',
      'text_delta',
      'usage',
      'turn_end',
      'done',
    ]);
    expect(lastUserMessage(second.requests[0])?.content).toContain('[task t1 · completed');
  });

  it('multiple tasks run concurrently, and their completions serialize through the queue', async () => {
    tasks = new TaskRegistry();
    const { provider } = recordingProvider([
      [
        background('a', 200, 'A'),
        background('b', 800, 'B'),
        { type: 'done', stopReason: 'tool_use' },
      ],
      say('Both started.'),
      say('A done.'),
      say('B done.'),
    ]);

    const started = performance.now();
    const events = await collect(streamAgent(options(provider)));

    expect(performance.now() - started).toBeLessThan(1_500); // 0.8s overall, not 1.0s+ serially plus turns
    const completions = events.flatMap((e) =>
      e.type === 'task_completed' ? [e.task.output.trim()] : [],
    );

    expect(completions).toEqual(['A', 'B']);
    // Each completion lands in its own turn, between turn boundaries.
    expect(types(events).filter((t) => t === 'turn_end' || t === 'task_completed')).toEqual([
      'turn_end',
      'turn_end',
      'task_completed',
      'turn_end',
      'task_completed',
      'turn_end',
    ]);
  });

  it('the agent can cancel a task; nothing is left to wait for, so the run ends', async () => {
    tasks = new TaskRegistry();
    const { provider } = recordingProvider([
      [background('c1', 5_000), { type: 'done', stopReason: 'tool_use' }],
      [
        {
          type: 'tool_call',
          call: {
            id: callIdSchema.parse('c2'),
            name: 'cancel_task',
            input: { description: 'stop it', id: 't1' },
          },
        },
        { type: 'done', stopReason: 'tool_use' },
      ],
      say('Stopped.'),
    ]);

    const started = performance.now();
    const events = await collect(streamAgent(options(provider)));

    expect(performance.now() - started).toBeLessThan(2_000);
    // The cancelled task is silent, and released at the turn boundary after its cancel_task result.
    expect(tasks.isReleased(t1)).toBe(true);
    expect(types(events)).not.toContain('task_completed');
    expect(events.at(-1)).toMatchObject({ type: 'done', reason: 'completed' });
  });

  it('waits for required work without waiting for an unrelated background server', async () => {
    tasks = new TaskRegistry();
    const finish = Promise.withResolvers<undefined>();

    tasks.start({
      command: 'review',
      description: 'Review',
      run: async ({ onOutput }) => {
        await finish.promise;
        onOutput('review findings');

        return { exitCode: 0 };
      },
    });
    const { provider, requests } = recordingProvider([
      [background('b', 60_000, '', 'service'), { type: 'done', stopReason: 'tool_use' }],
      say('Waiting for review.'),
      say('Review received.'),
    ]);
    const events = await collect(
      (async function* () {
        for await (const event of streamAgent(options(provider))) {
          yield event;
          if (event.type === 'turn_end' && event.turn === 2) finish.resolve(undefined);
        }
      })(),
    );

    expect(lastUserMessage(requests[2])?.content).toContain('review findings');
    expect(events.at(-1)).toMatchObject({ type: 'done', reason: 'completed' });
    expect(tasks.runningCount).toBe(1);
  });

  it('stops waiting when required work is cancelled, even if an ordinary task still runs', async () => {
    tasks = new TaskRegistry();
    const { provider } = recordingProvider([
      [
        background('a', 60_000),
        background('b', 60_000, '', 'service'),
        { type: 'done', stopReason: 'tool_use' },
      ],
      say('Waiting for review.'),
    ]);
    const events: AgentEvent[] = [];
    const running = (async () => {
      for await (const event of streamAgent(options(provider))) events.push(event);
    })();

    await until(() => events.filter((event) => event.type === 'turn_end').length === 2);
    await tasks.cancel(t1);
    await running;
    expect(types(events)).not.toContain('task_completed');
    expect(events.at(-1)).toMatchObject({ type: 'done', reason: 'completed' });
    expect(tasks.runningCount).toBe(1);
  });

  it('an interrupt stops waiting and cancels finite tasks and services', async () => {
    tasks = new TaskRegistry();
    const controller = new AbortController();
    const { provider } = recordingProvider([
      [
        background('c1', 5_000),
        background('server', 60_000, '', 'service'),
        { type: 'done', stopReason: 'tool_use' },
      ],
      say('Waiting.'),
    ]);

    setTimeout(() => controller.abort(), 200);
    const events = await collect(streamAgent(options(provider, { signal: controller.signal })));

    expect(events.at(-1)).toMatchObject({ type: 'done', reason: 'interrupted' });
    expect(tasks.list().map((task) => task.status)).toEqual(['cancelled', 'cancelled']);
  });
});

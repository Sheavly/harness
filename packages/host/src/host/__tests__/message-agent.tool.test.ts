import { describe, expect, it } from 'vitest';
import type { Provider, ProviderRequest } from '@sheavly/core/provider/provider.types';
import type { StreamEvent } from '@sheavly/core/message/message.types';
import { runSession, streamAgent } from '@sheavly/loop/stream-agent/stream-agent.helper';
import { MAX_QUEUED_MESSAGES } from '@sheavly/runtime/sessions/sessions.constants';
import { SessionRegistry } from '@sheavly/runtime/sessions/sessions.service';
import { TaskRegistry } from '@sheavly/runtime/tasks/tasks.service';
import {
  calls,
  createStepPicker,
  say,
  toolCall,
} from '@sheavly/testing/provider/routed-provider.fake';
import type { Script } from '@sheavly/testing/provider/provider.types';
import { createMessageAgentTool } from '@sheavly/tools/sub-agent/message-agent.tool';
import { createSubAgentTool } from '@sheavly/tools/sub-agent/sub-agent.tool';
import { registryScopes } from '@sheavly/tools/testing/registry-scopes.fake';
import type { AgentEvent } from '@sheavly/protocol/event/event.types';
import { callIdSchema } from '@sheavly/protocol/message/message.validator';
import { sessionIdSchema } from '@sheavly/protocol/session/session.validator';
import type { SessionInfo } from '@sheavly/protocol/session/session.types';
import type { TaskInfo } from '@sheavly/protocol/task/task.types';

const callId = callIdSchema.parse('c');

/** A promise you resolve later: holds a scripted step until the test lets it go. */
function gate() {
  let open: () => void = () => undefined;
  const opened = new Promise<void>((resolve) => {
    open = resolve;
  });

  return { open, opened };
}

/**
 * Like `routedProvider`, but each script step may wait first (so a test can steer a sub-agent
 * while it's mid-task), and every request is recorded per session for assertions.
 */
function gatedProvider(scripts: Record<string, { wait?: Promise<void>; reply: Script }[]>) {
  const pick = createStepPicker(scripts);
  const seen = new Map<string, ProviderRequest[]>();
  const provider: Provider = {
    async *stream(request) {
      const { script, step } = pick(request);

      seen.set(script, [...(seen.get(script) ?? []), request]);
      await step?.wait;
      yield* (step?.reply ?? (() => []))(request);
    },
  };

  return { provider, seen };
}

/** A registry with a main session and one running sub-agent under it. */
function mainWithChild(title: string) {
  const sessions = new SessionRegistry();
  const main = sessions.startMain({ title: 'Main' });
  const child = sessions.startChild({
    parentId: main.id,
    startedByCall: callIdSchema.parse('start'),
    title,
  });

  return { sessions, main, child };
}

const userTexts = (request: ProviderRequest | undefined) =>
  (request?.messages ?? []).filter((m) => m.role === 'user').map((m) => m.content);

describe('message_agent: steering a running sub-agent', () => {
  it('"research dogs", then "I specifically care about puppies": the sub-agent gets it, uncancelled', async () => {
    const sessions = new SessionRegistry();
    const tasks = new TaskRegistry();
    const main = sessions.startMain({ title: 'Main' });
    const researching = gate();
    let childId = '';
    // A delivered task is released, so its end is kept as it happens.
    const ended: TaskInfo[] = [];

    tasks.observe(({ update }) => {
      if (update.type === 'task_ended') ended.push(update.task);
    });

    let lastChild: SessionInfo | undefined;

    sessions.subscribe((u) => {
      if (u.type === 'session_started' && u.session.depth === 2) childId = u.session.id;
      if (u.session.depth === 2 && u.type !== 'session_released') lastChild = u.session;
    });

    const { provider, seen } = gatedProvider({
      // Main: start the sub-agent; then (after the user's steer arrives) pass it on.
      'Research dogs for me': [
        {
          reply: calls(
            toolCall({
              id: 'm1',
              name: 'start_agent',
              input: { title: 'Dogs', task: 'Research dogs' },
            }),
          ),
        },
        {
          reply: () => [
            toolCall({
              id: 'm2',
              name: 'message_agent',
              input: { session: childId, message: 'Focus specifically on puppies.' },
            }),
            { type: 'done', stopReason: 'tool_use' } satisfies StreamEvent,
          ],
        },
        { reply: say('Waiting for the research.') },
        { reply: say('Here is the puppy research.') },
      ],
      // Sub-agent: report, then hold mid-task until the steer was sent, then answer.
      'Research dogs': [
        {
          reply: calls(
            toolCall({ id: 's1', name: 'report_status', input: { status: 'researching dogs' } }),
          ),
        },
        { wait: researching.opened, reply: say('Puppies: they sleep 18 hours a day.') },
      ],
    });

    const tools = [
      createSubAgentTool({
        scopes: registryScopes({ sessions, tasks, runAgent: runSession }),
        provider,
        tools: [],
      }),
      createMessageAgentTool({ sessions, children: sessions }),
    ];
    const events: AgentEvent[] = [];

    // The user steers the main session once the sub-agent is running.
    const run = (async () => {
      for await (const event of streamAgent({
        provider,
        tools,
        messages: [{ role: 'user', content: 'Research dogs for me' }],
        tasks,
        session: { registry: sessions, ref: main },
      })) {
        events.push(event);

        if (event.type === 'task_running') {
          sessions.send({
            id: main.id,
            content: 'I specifically care about puppies',
            from: 'user',
          });
        }

        if (event.type === 'tool_result' && event.call.name === 'message_agent') researching.open();
      }
    })();

    await run;

    // Delivered, so released: what it was is what its last update showed.
    const child = lastChild;

    expect(sessions.get(sessionIdSchema.parse(childId))).toBeUndefined();
    // The sub-agent's second model call had the parent's steer in its history.
    const childSecondCall = seen.get('Research dogs')?.[1];

    expect(child).toMatchObject({ parentId: main.id, state: 'completed' });
    expect(userTexts(childSecondCall).at(-1)).toMatch(
      new RegExp(
        `^Message from the agent that started you \\(session ${main.id}\\)[\\s\\S]*Focus specifically on puppies\\.$`,
      ),
    );
    // The main session saw the user's steer as a message, in its own ordered events.
    expect(events.find((e) => e.type === 'message_received')).toMatchObject({
      message: { from: 'user', content: 'I specifically care about puppies' },
    });
    // Nothing was cancelled: the task completed, and its reply reached the main session.
    expect(ended[0]?.status).toBe('completed');
    expect(ended[0]?.output).toContain('[message] Focus specifically on puppies.');
    expect(events.at(-1)).toMatchObject({ type: 'done', reason: 'completed' });
  });

  it('wakes a sub-agent waiting idle on its own tasks, so it acts on the message', async () => {
    const { sessions, main, child } = mainWithChild('Idle');
    const childTasks = new TaskRegistry();
    const taskDone = gate();
    const { provider, seen } = gatedProvider({
      Idle: [{ reply: say('Waiting on my task.') }, { reply: say('Got it: puppies.') }],
    });

    // A task that only ends when the test says so: without the message, the sub-agent would sit
    // waiting for it.
    childTasks.start({
      command: 'slow',
      description: 'slow',
      run: () => taskDone.opened.then(() => ({ exitCode: 0 })),
    });

    const done = runSession({
      provider,
      tools: [],
      messages: [{ role: 'user', content: 'Idle' }],
      tasks: childTasks,
      maxTurns: 2,
      session: { registry: sessions, ref: child },
    });

    // Let it reach the idle wait, then steer it.
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(seen.get('Idle')).toHaveLength(1);
    sessions.send({ id: child.id, content: 'puppies only', from: main.id });
    await new Promise((resolve) => setTimeout(resolve, 20));

    // The message woke it: a second model call, with the message, before the task finished.
    expect(seen.get('Idle')).toHaveLength(2);
    expect(userTexts(seen.get('Idle')?.[1]).at(-1)).toContain('puppies only');

    taskDone.open();
    const { messages } = await done;

    expect(messages.some((m) => 'content' in m && m.content === 'Got it: puppies.')).toBe(true);
  });

  it('a message arriving during the last turn gets one more turn instead of ending the run', async () => {
    const sessions = new SessionRegistry();
    const main = sessions.startMain({ title: 'Main' });
    const { provider, seen } = gatedProvider({
      Start: [
        {
          reply: () => {
            sessions.send({ id: main.id, content: 'one more thing', from: 'user' });

            return [
              { type: 'text_delta', text: 'first' },
              { type: 'done', stopReason: 'end_turn' },
            ];
          },
        },
        { reply: say('second') },
      ],
    });

    const { reason, messages } = await runSession({
      provider,
      tools: [],
      messages: [{ role: 'user', content: 'Start' }],
      session: { registry: sessions, ref: main },
    });

    expect(reason).toBe('completed');
    expect(seen.get('Start')).toHaveLength(2);
    expect(messages.flatMap((m) => ('content' in m ? [m.content] : []))).toEqual([
      'Start',
      'first',
      'one more thing',
      'second',
    ]);
  });

  it('says a delivered sub-agent was released, not that it is unknown', async () => {
    const { sessions, main, child } = mainWithChild('Done');
    const tool = createMessageAgentTool({ sessions, children: sessions });

    sessions.end({ id: child.id, state: 'completed' });
    sessions.releaseAgent(child.id);

    await expect(
      tool.execute({
        input: { session: child.id, message: 'more' },
        signal: new AbortController().signal,
        context: { callId, description: 'd', session: main },
      }),
    ).rejects.toThrow('was released');
  });

  it('refuses a message while the sub-agent still holds all it may, which the loop shows the model as a tool error', async () => {
    const { sessions, main, child } = mainWithChild('Busy');
    const tool = createMessageAgentTool({ sessions, children: sessions });
    const send = () =>
      tool.execute({
        input: { session: child.id, message: 'more' },
        signal: new AbortController().signal,
        context: { callId, description: 'd', session: main },
      });

    for (let each = 0; each < MAX_QUEUED_MESSAGES; each += 1) await send();

    await expect(send()).rejects.toThrow('already has messages waiting');
    expect(sessions.takeMessages(child.id)).toHaveLength(MAX_QUEUED_MESSAGES);
    // Taken, the sub-agent can be messaged again.
    await expect(send()).resolves.toContain('Sent to sub-agent');
  });

  it('refuses to message a session the caller did not start', async () => {
    const sessions = new SessionRegistry();
    const main = sessions.startMain({ title: 'Main' });
    const startedByCall = callIdSchema.parse('start');
    const a = sessions.startChild({ parentId: main.id, startedByCall, title: 'A' });
    const b = sessions.startChild({ parentId: main.id, startedByCall, title: 'B' });
    const tool = createMessageAgentTool({ sessions, children: sessions });
    const signal = new AbortController().signal;

    await expect(
      tool.execute({
        input: { session: b.id, message: 'hi' },
        signal,
        context: { callId, description: 'd', session: a },
      }),
    ).rejects.toThrow('did not start');
    await expect(
      tool.execute({
        input: { session: a.id, message: 'hi' },
        signal,
        context: { callId, description: 'd' },
      }),
    ).rejects.toThrow('only works inside an agent session');
    expect(sessions.hasMessages(b.id)).toBe(false);
  });
});

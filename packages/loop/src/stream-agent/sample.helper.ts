import { now } from '@sheavly/core/clock/clock.helper';
import { ConnectionLostError } from '@sheavly/core/errors/connection.errors';
import { toDefinition } from '@sheavly/core/tool/tool.utils';
import { describeCall } from '@sheavly/core/tool/tool.validator';
import { untilAborted, whenAborted } from '../abort/abort.utils.js';
import { contextNotice } from '../context/context.utils.js';
import type { ToolOutcome } from '../events/events.types.js';
import { runToolCall } from '../hooks/hooks.helper.js';
import { createReasoningActivity } from './reasoning-activity.helper.js';
import { runningTasksNotice } from './running-tasks-notice.helper.js';
import { INTERRUPTED_BY_USER, STOPPED_BY_FAILURE } from './stream-agent.constants.js';
import type { RunningCall, SampleContext, SampleFailure, ToolStart } from './stream-agent.types.js';
import type { DescribedCall } from '@sheavly/protocol/event/event.types';
import type { TransientNotice } from '@sheavly/protocol/notice/notice.types';
import type { ModelUsage } from '@sheavly/protocol/usage/usage.types';
import type {
  Message,
  ReasoningItem,
  ToolCall,
  ToolMessage,
  TurnStopReason,
} from '@sheavly/protocol/message/message.types';

/**
 * One model call: stream the response into an assistant message.
 * Tool calls start running the moment they arrive, while the model keeps streaming.
 * On abort, keeps whatever the model produced so far. If the model call fails, the tools it
 * started are stopped and `failure` holds the error, so the turn can record them before failing.
 */
export async function sample(context: SampleContext) {
  const { provider, instructions, tools, messages, signal, aborted, events } = context;
  const { state } = context;
  const { window } = state;
  const notice = contextNotice(state);
  const taskNotice = runningTasksNotice({ tasks: context.tasks, sessionId: context.session.id });
  // Typed transient: sent beside the call, never stored. A persistent kind goes through
  // `publishNotice`, so it cannot be added here and streamed without being kept.
  const notices: TransientNotice[] = [
    ...(notice ? [notice] : []),
    ...(context.continuation ? [context.continuation] : []),
    ...(taskNotice ? [taskNotice] : []),
  ];
  let content = '';
  const toolCalls: ToolCall[] = [];
  const reasoning: ReasoningItem[] = [];
  const running: RunningCall[] = [];
  const finished = { count: 0 };
  const activity = createReasoningActivity(events);
  let stopReason: TurnStopReason = 'end_turn';
  let failure: SampleFailure | undefined;
  let usage: ModelUsage = { tokens: null };
  // The tools' own signal: aborted with the run, or when this model call fails.
  const stopTools = new AbortController();
  const toolSignal = AbortSignal.any([signal, stopTools.signal]);
  const stopped = Promise.race([
    aborted.then(() => INTERRUPTED_BY_USER),
    whenAborted(stopTools.signal).then(() => STOPPED_BY_FAILURE),
  ]);
  const start = { ...context, signal: toolSignal };

  try {
    // Notices go beside the history snapshot, never in it. Every UI receives the same data
    // before the model starts, and chooses whether to display it.
    for (const notice of notices) events.enqueue({ type: 'harness_notice', notice });

    const source = provider.stream({
      instructions,
      messages: [...messages],
      notices,
      // The session id never changes across turns, resumes or wake-ups, and a sub-agent has its own.
      cacheKey: context.session.id,
      tools: tools.map(toDefinition),
      signal,
    });

    for await (const event of untilAborted({ source, aborted })) {
      switch (event.type) {
        case 'text_delta':
          content += event.text;
          events.enqueue(event);
          break;
        case 'reasoning':
          reasoning.push(event.item);
          events.enqueue(event);
          break;
        case 'reasoning_activity':
          activity.set(event.active);
          break;
        case 'model_connection':
          events.enqueue(event);
          break;

        case 'tool_call': {
          const described = { call: event.call, description: describeCall(event.call) };

          toolCalls.push(event.call);
          events.enqueue({ type: 'tool_call_started', ...described });
          running.push(trackFinish({ described, start, stopped, finished }));
          break;
        }

        case 'done':
          stopReason = event.stopReason;
          usage = event.usage ?? { tokens: null };
          break;
      }
    }
  } catch (caughtError) {
    // A real provider failure, not our interrupt.
    if (!signal.aborted) failure = failedWith({ error: caughtError, stopTools });
  }

  activity.close();

  // The window the call ran against: the reading taken before the call, the same the agent was
  // told. A window a provider put on its own usage is dropped, since it was never checked.
  const { contextWindow: _unchecked, ...reported } = usage;

  events.enqueue({
    type: 'usage',
    usage: window === undefined ? reported : { ...reported, contextWindow: window },
  });
  if (signal.aborted || failure) stopReason = 'interrupted';

  const message: Message = {
    role: 'assistant',
    content,
    toolCalls,
    ...(reasoning.length > 0 ? { reasoning } : {}),
    at: now(),
  };

  return { message, stopReason, running, failure };
}

/**
 * A failed model call, with the tools it started stopped. A lost connection leaves them running:
 * the turn may go on from what arrived, and stops them itself (`stopTools`) if it does not.
 */
function failedWith(params: { error: unknown; stopTools: AbortController }): SampleFailure {
  const { error, stopTools } = params;
  const stop = () => {
    stopTools.abort(error);
  };

  if (!(error instanceof ConnectionLostError)) stop();

  return { error, stopTools: stop };
}

/**
 * Starts a tool and notes, the moment it finishes, where it came among the turn's calls. The
 * turn releases results in that order, so one that finished while the model still streamed is
 * not put back in call order.
 */
function trackFinish(params: {
  described: DescribedCall;
  start: ToolStart;
  stopped: Promise<string>;
  finished: { count: number };
}): RunningCall {
  const { described, start, stopped, finished } = params;
  const call: RunningCall = {
    described,
    outcome: startTool({ start, described, stopped }).then((outcome) => {
      call.settled = { order: finished.count++, outcome };

      return outcome;
    }),
  };

  return call;
}

/**
 * Starts a tool now, through the run's hooks. `runToolCall` never throws, so one failure can't
 * sink the others.
 * When `stopped` resolves (the run aborted, or the model call failed) the tool is told to stop
 * (via `signal`) and its result becomes that placeholder right away, even if it ignores the signal.
 * If the call launched a background task, the outcome is `task_running` instead of a result.
 */
async function startTool(params: {
  start: ToolStart;
  described: DescribedCall;
  stopped: Promise<string>;
}): Promise<ToolOutcome> {
  const { start, described, stopped } = params;
  const { tools, hooks = [], tasks, session, signal, onHookError } = start;
  const { call, description } = described;
  const started = performance.now();
  const { message, artifacts } = await Promise.race([
    runToolCall({ hooks, tools, call, signal, session, onHookError }),
    stopped.then((content) => {
      const placeholder: ToolMessage = {
        role: 'tool',
        toolCallId: call.id,
        content,
        isError: true,
        at: now(),
      };

      return { message: placeholder, artifacts: undefined };
    }),
  ]);
  const durationMs = performance.now() - started;

  // The registry is shared by the run's sessions, and a provider's call ids are only unique within
  // one: look among this session's tasks, never another's.
  const task = tasks?.byCallId({ callId: call.id, sessionId: session?.id });
  // The node the call launched, which the child does not have when the call starts: the parent's
  // card is joined to the child's channel with it. A task found above always has one (both read
  // the registry's one map), so the check only narrows the type.
  const nodeId = task && tasks?.nodeIdOf(task.id);

  if (task && nodeId !== undefined && !message.isError) {
    return { type: 'task_running', task, nodeId, call, description, message, durationMs };
  }

  return {
    type: 'tool_result',
    call,
    description,
    message,
    durationMs,
    ...(artifacts?.length ? { artifacts } : {}),
  };
}

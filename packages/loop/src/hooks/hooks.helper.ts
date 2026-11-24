import { isDeepStrictEqual } from 'node:util';
import { now } from '@sheavly/core/clock/clock.helper';
import type {
  AfterTurnContext,
  ContextState,
  Hook,
  SummaryReason,
  ToolResult,
} from '@sheavly/core/hook/hook.types';
import type { SummarySection } from '@sheavly/core/summary/summary.types';
import type { Tool, ToolArtifacts, ToolRunResult } from '@sheavly/core/tool/tool.types';
import { runTool } from '@sheavly/core/tool/tool.helper';
import { describeCall } from '@sheavly/core/tool/tool.validator';
import { assertValidHistory, countChanges } from '../history/history.utils.js';
import { parseSentMessages } from '../history/history.validator.js';
import { mergeSections, viewOf } from '../summary/summary.utils.js';
import { parseSummaryChange } from './summary-change.validator.js';
import { redactDiagnosticText } from '@sheavly/core/text/diagnostic-text.utils';
import { escapedLine } from '@sheavly/core/text/text.utils';
import { guarded, withTimeout } from './guarded.helper.js';
import { SESSION_END_TIMEOUT_MS } from './hooks.constants.js';
import type { OnHookError } from './hooks.types.js';
import type { HistoryMessage } from '@sheavly/protocol/history/history.types';
import type {
  Message,
  SummaryMessage,
  ToolCall,
  ToolMessage,
} from '@sheavly/protocol/message/message.types';
import type { SessionRef } from '@sheavly/protocol/session/session.types';

/** Someone to tell about every context addition (the loop emits `context_added`). */
type OnContext = (added: { hook: string; content: string }) => void;

/**
 * `addContext` for one hook: appends a user message to the run's history and reports it. Every
 * handler is handed the model's view of that history (`viewOf`), never the stored entries: a
 * hook sees the shortened state after a summary and never the `summary` role. A hook still
 * running after the run was aborted adds nothing: history is not for a late call to grow.
 */
export function contextAdder(params: {
  hook: Hook;
  messages: HistoryMessage[];
  signal: AbortSignal;
  onContext: OnContext;
}) {
  const { hook, messages, signal, onContext } = params;

  return (content: string) => {
    if (signal.aborted) return;
    messages.push({ role: 'user', content, at: now() });
    onContext({ hook: hook.name, content });
  };
}

/**
 * Runs every `sessionStart` handler in order, once per run, before the first turn. A handler that
 * fails is reported through `onHookError` and skipped; the run goes on.
 */
export async function runSessionStart(params: {
  hooks: Hook[];
  messages: HistoryMessage[];
  signal: AbortSignal;
  onContext: OnContext;
  onHookError: OnHookError;
}): Promise<void> {
  const { hooks, messages, signal, onContext, onHookError } = params;

  for (const hook of hooks) {
    const { sessionStart } = hook;

    if (!sessionStart || signal.aborted) continue;
    await guarded({
      hook,
      handler: 'sessionStart',
      signal,
      onHookError,
      work: () =>
        sessionStart({
          messages: viewOf(messages),
          signal,
          addContext: contextAdder({ hook, messages, signal, onContext }),
        }),
    });
  }
}

/**
 * Runs every `beforeTurn` handler in order. Each sees the history including context added by
 * the hooks before it; `onContext` hears about every addition (for the event stream). Returns
 * the system instructions the hooks added for this turn, in hook order.
 */
export async function runBeforeTurn(params: {
  hooks: Hook[];
  turn: number;
  messages: HistoryMessage[];
  context: ContextState;
  signal: AbortSignal;
  onContext: OnContext;
  onHookError: OnHookError;
}): Promise<string[]> {
  const { hooks, turn, messages, context, signal, onContext, onHookError } = params;
  const instructions: string[] = [];

  for (const hook of hooks) {
    const { beforeTurn } = hook;

    if (!beforeTurn || signal.aborted) continue;
    // Instructions are kept only from a handler that finished: a failed one adds none.
    const added: string[] = [];
    const result = await guarded({
      hook,
      handler: 'beforeTurn',
      signal,
      onHookError,
      work: () =>
        beforeTurn({
          turn,
          context: { ...context },
          messages: viewOf(messages),
          signal,
          addContext: contextAdder({ hook, messages, signal, onContext }),
          addInstructions: (content) => {
            if (content.trim()) added.push(content);
          },
        }),
    });

    if (result.ok && !signal.aborted) instructions.push(...added);
  }

  return instructions;
}

/**
 * Runs every `beforeModelCall` handler in order for one model call; each gets a deep copy of the
 * previous result and may return other messages. Returns the messages to send. The copies mean
 * a hook that edits what it was given (it may be plain JavaScript) changes nothing stored, and
 * the result is parsed into new objects, so it can't be changed after it was checked either.
 * A result that is not a list of messages, or that breaks the history rules, throws an
 * `InvalidHistoryError` naming the hook. A hook that returns its input unchanged is never
 * blamed: history that was already broken is the caller's to deal with. `onChanged` hears about
 * every hook whose result added, dropped or edited messages (`countChanges`), for the event
 * stream.
 */
export async function runBeforeModelCall(params: {
  hooks: Hook[];
  turn: number;
  messages: readonly Message[];
  context: ContextState;
  signal: AbortSignal;
  onChanged: (change: { hook: string; added: number; removed: number; edited: number }) => void;
  onHookError: OnHookError;
}): Promise<readonly Message[]> {
  const { hooks, turn, messages, context, signal, onChanged, onHookError } = params;
  const latestUser = messages.findLast((message) => message.role === 'user');
  let current = messages;

  for (const hook of hooks) {
    const { beforeModelCall } = hook;

    if (!beforeModelCall || signal.aborted) continue;

    const source = `Hook ${hook.name}`;
    const before = current;
    // Parsing and the history check run inside the guard: a hook whose result breaks the rules
    // is skipped like one that throws, and the model is sent the messages from before it.
    const result = await guarded({
      hook,
      handler: 'beforeModelCall',
      signal,
      onHookError,
      work: async () => {
        // Typed `unknown`: a project hook is plain JavaScript, so its return value is unchecked.
        const returned: unknown = await beforeModelCall({
          turn,
          messages: structuredClone(before),
          context: { ...context },
          signal,
        });
        const sent = parseSentMessages({ input: returned, source });

        if (!isDeepStrictEqual(sent, before)) {
          assertValidHistory({ messages: sent, latestUser, source });
        }

        return sent;
      },
    });

    if (!result.ok || result.value === undefined || isDeepStrictEqual(result.value, before)) {
      continue;
    }

    const { added, removed, edited } = countChanges({ before, after: result.value });

    if (added > 0 || removed > 0 || edited > 0) {
      onChanged({ hook: hook.name, added, removed, edited });
    }

    current = result.value;
  }

  return current;
}

/**
 * Runs every `beforeSummary` handler in order and combines what they asked for: the last
 * `keepTokens` wins, and the sections add up (a later hook's replaces an earlier one's with the
 * same id). Each handler gets a deep copy of the view, so editing it changes nothing stored. A
 * handler that throws is a `HookError`, and a result that is not a valid change a
 * `SummaryHookError`, both naming the hook; the caller reports either as a failed summary. Stops
 * asking hooks once the run aborts.
 */
export async function runBeforeSummary(params: {
  hooks: Hook[];
  reason: SummaryReason;
  messages: readonly Message[];
  context: ContextState;
  signal: AbortSignal;
  onHookError: OnHookError;
}): Promise<{ keepTokens: number | undefined; sections: SummarySection[] }> {
  const { hooks, reason, messages, context, signal, onHookError } = params;
  let keepTokens: number | undefined;
  let sections: SummarySection[] = [];

  for (const hook of hooks) {
    const { beforeSummary } = hook;

    // Stop asking once aborted; the caller sees the abort and fails the summary.
    if (signal.aborted) break;

    if (!beforeSummary) continue;

    // Typed `unknown`: a project hook is plain JavaScript, so its return value is unchecked.
    // A hook that throws, or whose result is not a valid change, is reported and skipped: the
    // summary is written without its contribution.
    const result = await guarded({
      hook,
      handler: 'beforeSummary',
      signal,
      onHookError,
      work: async () => {
        const returned: unknown = await beforeSummary({
          reason,
          messages: structuredClone(messages),
          context: { ...context },
          signal,
        });

        return parseSummaryChange({ input: returned, hook: hook.name });
      },
    });

    if (signal.aborted) break;

    if (!result.ok) continue;

    keepTokens = result.value?.keepTokens ?? keepTokens;
    sections = mergeSections({ written: sections, added: result.value?.sections ?? [] });
  }

  return { keepTokens, sections };
}

/**
 * Runs every `afterSummary` handler in order, once the checkpoint is in history. Each gets copies
 * of the checkpoint and of the model's view of history (`viewOf`), and what it adds with
 * `addContext` lands after the checkpoint, reported through `onContext` like any other context.
 * Stops waiting for a hook, and asking the next, once the run aborts.
 */
export async function runAfterSummary(params: {
  hooks: Hook[];
  reason: SummaryReason;
  checkpoint: SummaryMessage;
  messages: HistoryMessage[];
  signal: AbortSignal;
  onContext: OnContext;
  onHookError: OnHookError;
}): Promise<void> {
  const { hooks, reason, checkpoint, messages, signal, onContext, onHookError } = params;

  for (const hook of hooks) {
    const { afterSummary } = hook;

    if (signal.aborted) return;

    if (!afterSummary) continue;

    // Copies, so a plain-JavaScript hook that edits what it was given can't change the stored
    // checkpoint after `buildCheckpoint` checked it; each hook gets its own.
    await guarded({
      hook,
      handler: 'afterSummary',
      signal,
      onHookError,
      work: () =>
        afterSummary({
          reason,
          checkpoint: structuredClone(checkpoint),
          messages: structuredClone(viewOf(messages)),
          signal,
          addContext: contextAdder({ hook, messages, signal, onContext }),
        }),
    });
  }
}

/**
 * Runs every `afterTurn` handler in order, once the turn's reply and results are in history. A
 * handler that fails is reported through `onHookError` and skipped; the run goes on.
 */
export async function runAfterTurn(
  params: { hooks: Hook[]; onHookError: OnHookError } & Omit<AfterTurnContext, 'messages'> & {
      messages: HistoryMessage[];
    },
): Promise<void> {
  const { hooks, messages, onHookError, ...turn } = params;

  for (const hook of hooks) {
    const { afterTurn } = hook;

    if (!afterTurn || turn.signal.aborted) continue;
    await guarded({
      hook,
      handler: 'afterTurn',
      signal: turn.signal,
      onHookError,
      work: () => afterTurn({ ...turn, messages: viewOf(messages) }),
    });
  }
}

/**
 * Tells every `onError` handler, in order, that the run failed. A handler that throws doesn't
 * stop the others, and the original error is still the one the caller sees; its failure is
 * reported through `onHookError` as a `HookError` (the loop emits `hook_failed`).
 */
export async function runOnError(params: {
  hooks: Hook[];
  error: unknown;
  messages: HistoryMessage[];
  onHookError: OnHookError;
}): Promise<void> {
  const { hooks, error, messages, onHookError } = params;
  // The run's signal is usually aborted by now and an error hook must still run, so it is
  // raced against a signal that never aborts.
  const never = new AbortController().signal;

  for (const hook of hooks) {
    const { onError } = hook;

    if (!onError) continue;
    await guarded({
      hook,
      handler: 'onError',
      signal: never,
      onHookError,
      // Bounded: a hanging error hook must not keep the original error from reaching the caller.
      work: () =>
        withTimeout({
          work: onError({ error, messages: viewOf(messages) }),
          timeoutMs: SESSION_END_TIMEOUT_MS,
        }),
    });
  }
}

/**
 * Runs a tool call through every `aroundToolCall` handler (the first is outermost), then the
 * tool. Never throws: a failing hook becomes an error result, like a failing tool. Returns the
 * history message and, apart from it, the tool's artifacts (which the model never sees).
 */
export async function runToolCall(params: {
  hooks: Hook[];
  tools: Tool[];
  call: ToolCall;
  signal: AbortSignal;
  /** The calling session, handed to the tool (`context.session`). */
  session?: SessionRef | undefined;
  /** Told about a hook that failed; the call is still blocked with an error result. */
  onHookError: OnHookError;
}): Promise<{ message: ToolMessage } & ToolArtifacts> {
  const { hooks, tools, call, signal, session, onHookError } = params;
  const handlers = hooks.filter((hook) => hook.aroundToolCall);
  const description = describeCall(call);

  const runFrom = async (index: number, current: ToolCall): Promise<ToolResult> => {
    const hook = handlers[index];

    if (!hook?.aroundToolCall) {
      return toResult(await runTool({ tools, call: current, signal, session }));
    }

    const { aroundToolCall } = hook;
    const result = await guarded({
      hook,
      handler: 'aroundToolCall',
      signal,
      onHookError,
      work: () =>
        aroundToolCall({
          call: current,
          description,
          signal,
          next: (input) =>
            runFrom(index + 1, input === undefined ? current : { ...current, input }),
        }),
    });

    // Fail closed: a hook that threw, or that the abort cut short, blocks the call with an error
    // result, and a failure is reported like every other hook's.
    if (!result.ok) {
      const { error } = result;

      // This reaches the model as the result of someone else's call, and the hook's code (an
      // extension's or a project's) wrote the message: one escaped line, like the hook-failed notice.
      const reason = redactDiagnosticText(error instanceof Error ? error.message : String(error));

      return {
        content: `Hook ${escapedLine(hook.name)} failed: ${escapedLine(reason)}`,
        isError: true,
      };
    }

    return (
      result.value ?? { content: `Hook ${escapedLine(hook.name)} was interrupted`, isError: true }
    );
  };

  const { content, isError, artifacts } = await runFrom(0, call);

  return {
    message: { role: 'tool', toolCallId: call.id, content, isError, at: now() },
    artifacts,
  };
}

function toResult(run: ToolRunResult): ToolResult {
  return { content: run.content, isError: run.isError, artifacts: run.artifacts };
}

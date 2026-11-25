import { contextState } from '../context/context.utils.js';
import { runAfterTurn, runBeforeModelCall, runBeforeTurn } from '../hooks/hooks.helper.js';
import { joinInstructions } from '../hooks/hooks.utils.js';
import { viewOf } from '../summary/summary.utils.js';
import { HookError } from '../errors/loop.errors.js';
import { sample } from './sample.helper.js';
import { runContribution } from './contributions.helper.js';
import type {
  DeliveryState,
  LimitInput,
  LimitOutcome,
  TurnContributions,
} from './contributions.types.js';
import type { AgentEvents, RunningCall, TurnContext } from './stream-agent.types.js';
import type { DoneReason } from '@sheavly/protocol/event/event.types';
import type { HistoryMessage } from '@sheavly/protocol/history/history.types';
import type { Message, TurnStopReason } from '@sheavly/protocol/message/message.types';

/** One model call plus its tool results. Returns why the run ends, or undefined to keep going. */
export async function runTurn(context: TurnContext): Promise<DoneReason | undefined> {
  const { options, session, turn, messages, signal, aborted, events } = context;

  if (signal.aborted) return 'interrupted';

  await runPhase({ context, list: context.contributions.delivery });

  // An abort while a delivery hook ran ends the run as interrupted, like every other abort.
  if (signal.aborted) return 'interrupted';

  // After tasks and messages are in history, before any hook: hooks see the shortened state.
  // No summary could make room and the view fills the window: stop here, recoverably (the history
  // is untouched and valid), rather than send a call the provider is sure to reject.
  const room = await makeRoom(context);

  // An abort during the summary ends the run as interrupted, whatever the view's size.
  if (signal.aborted) return 'interrupted';

  if (room === 'full') return 'context_window_exceeded';

  // Read once, so the hooks, the agent and the usage event all see the same numbers.
  const state = contextState({
    window: options.provider.contextWindow,
    lastTokens: session.registry.lastTokens(session.ref.id),
  });
  const instructions = await runBeforeTurn({
    hooks: options.hooks ?? [],
    turn,
    messages,
    context: state,
    signal,
    onContext: (added) => events.enqueue({ type: 'context_added', ...added }),
    onHookError: context.hookFailures.report,
  });

  // For this call only: `messages` stays the stored history, and the turn appends to that. The
  // model is sent the view (the newest checkpoint as text, then the messages it kept).
  // Old large tool results are hidden here too when a summary is configured: it is the cheaper
  // first step, and it delays the summary instead of replacing it.
  const view = await shapeView({ context, view: viewOf(messages) });
  const sent = await runBeforeModelCall({
    hooks: options.hooks ?? [],
    turn,
    messages: view,
    context: state,
    signal,
    onChanged: (change) => events.enqueue({ type: 'model_input_changed', turn, ...change }),
    onHookError: context.hookFailures.report,
  });

  // An abort during a hook ends the run as interrupted, like every other abort; nothing has been
  // added to history yet, so it stays valid.
  if (signal.aborted) return 'interrupted';

  const continuation = context.outputRecovery.pending;

  context.outputRecovery.pending = undefined;
  const sampled = await sample({
    ...options,
    instructions: joinInstructions([options.instructions, ...instructions]),
    session: session.ref,
    messages: sent,
    state,
    continuation,
    signal,
    aborted,
    events,
    onHookError: context.hookFailures.report,
  });

  return settleModelCall({ context, sampled });
}

/** What one model call left behind: its reply, the tools it started, and how it ended. */
type Sampled = Awaited<ReturnType<typeof sample>>;

/**
 * Records the model call's reply and tool results, recovers from a failure or fails the run with
 * it, and otherwise finishes the turn. Returns why the run ends, or undefined to keep going.
 */
async function settleModelCall(params: {
  context: TurnContext;
  sampled: Sampled;
}): Promise<DoneReason | undefined> {
  const { context, sampled } = params;
  const { message, stopReason, running, failure } = sampled;
  const { options, turn, messages, signal, events } = context;

  // A reply cut by a lost connection is kept as it arrived, and the turn goes on from it.
  const recovered = await recoverOrStopTools({ context, sampled });

  // A failed model call that started no tools fails the turn as it is, with nothing to record.
  if (failure && !recovered && running.length === 0) throw failure.error;

  if (await retryAfterOverflow({ context, stopReason, started: running.length > 0 })) {
    // The rejected reply is dropped from history, but a UI that saw the call start sees it end.
    events.enqueue({ type: 'turn_end', turn, stopReason });

    return undefined;
  }

  // An interrupt before the model said anything leaves no trace in history. A recovered reply with
  // no text and no tool call leaves none either, reasoning included: the next call starts that
  // thinking again, and a reasoning item with nothing after it is not one a provider accepts back.
  const unsaid = !message.content && message.toolCalls.length === 0;
  const empty = unsaid && !message.reasoning;

  if (!((signal.aborted && empty) || (recovered && unsaid))) messages.push(message);

  events.enqueue({ type: 'turn_end', turn, stopReason });

  if (running.length > 0) messages.push(...(await releaseResults({ running, events })));

  // The failed model call's tools are stopped and recorded; now the run fails with its error.
  if (failure && !recovered) throw failure.error;

  // The turn did not finish: no `afterTurn`, no limits. The next one asks the model to go on.
  if (recovered) return undefined;

  await runAfterTurn({
    hooks: options.hooks ?? [],
    turn,
    stopReason,
    reply: message,
    messages,
    signal,
    onHookError: context.hookFailures.report,
  });

  return finishTurn({ context, stopReason, running, reply: message });
}

/** The first `room` contribution to answer decides; with none registered no room is made. */
async function makeRoom(context: TurnContext): Promise<'full' | undefined> {
  for (const contribution of context.contributions.room) {
    const { value } = await runContribution({
      contribution,
      input: context,
      signal: context.signal,
      report: reportContribution(context),
    });

    if (value) return value;
  }

  return undefined;
}

/** Runs the start-of-turn delivery steps in order, each seeing what the earlier ones recorded. */
async function runPhase(params: {
  context: TurnContext;
  list: TurnContributions['delivery'];
}): Promise<void> {
  const { context, list } = params;
  const state: DeliveryState = { noticesFrom: context.messages.length, tasks: [] };

  for (const contribution of list) {
    await runContribution({
      contribution,
      input: { context, state },
      signal: context.signal,
      report: reportContribution(context),
    });
  }
}

/** Passes the view through each `view` contribution in order; the result is what the model sees. */
async function shapeView(params: {
  context: TurnContext;
  view: readonly Message[];
}): Promise<readonly Message[]> {
  const { context, view } = params;
  let current = view;

  for (const contribution of context.contributions.view) {
    const { value } = await runContribution({
      contribution,
      input: { view: current, window: context.options.provider.contextWindow },
      signal: context.signal,
      report: reportContribution(context),
    });

    current = value ?? current;
  }

  return current;
}

/** A skipped contribution is reported like a failed hook: `hook_failed`, and a model notice. */
function reportContribution(context: TurnContext) {
  return ({ name, error }: { name: string; error: unknown }) =>
    context.hookFailures.report(
      new HookError({ hook: name, handler: 'contribution', cause: error }),
    );
}

/**
 * A call the provider rejected as too long: the `overflow` contributions may recover and ask for
 * a retry. True when one did; the caller drops the rejected reply and the next turn calls the
 * model again. With none registered the run ends `context_window_exceeded`. This is recovery by
 * changing what is sent, not the providers' retry policy (`http/retry-policy.helper.ts`), which
 * repeats the same call after a wait.
 */
async function retryAfterOverflow(params: {
  context: TurnContext;
  stopReason: TurnStopReason;
  /** The rejected call had already started tools: its history is not ours to rewind. */
  started: boolean;
}): Promise<boolean> {
  const { context } = params;

  for (const contribution of context.contributions.overflow) {
    const { value } = await runContribution({
      contribution,
      input: params,
      signal: context.signal,
      report: reportContribution(context),
    });

    if (value) return true;
  }

  return false;
}

/**
 * Whether the turn goes on from a model call that failed with a lost connection. A call that
 * completed starts the count of lost connections again. The tools a lost connection spared are
 * left running only when the turn goes on: otherwise (or if a contribution throws) they are
 * stopped here, as any other failure stops them.
 */
async function recoverOrStopTools(params: {
  context: TurnContext;
  sampled: Sampled;
}): Promise<boolean> {
  const { context, sampled } = params;
  const { failure } = sampled;

  if (!failure) {
    context.connectionLosses.inARow = 0;

    return false;
  }

  try {
    const recovered = await recoverFromLostConnection({ context, error: failure.error });

    if (!recovered) failure.stopTools();

    return recovered;
  } catch (caughtError) {
    failure.stopTools();

    throw caughtError;
  }
}

/**
 * A model call that failed with its reply half sent: the `dropped` contributions may go on from
 * what arrived. True when one did (the first wins), and the next turn asks the model to continue.
 * With none, or for any other error, the run fails with the error.
 */
async function recoverFromLostConnection(params: {
  context: TurnContext;
  error: unknown;
}): Promise<boolean> {
  const { context } = params;

  if (context.signal.aborted) return false;

  for (const contribution of context.contributions.dropped) {
    const { value } = await runContribution({
      contribution,
      input: params,
      signal: context.signal,
      report: reportContribution(context),
    });

    if (value) return true;
  }

  return false;
}

/** Resolves recovery, pending work and completion only after results and afterTurn hooks. */
async function finishTurn(params: {
  context: TurnContext;
  stopReason: TurnStopReason;
  running: readonly RunningCall[];
  reply: HistoryMessage;
}): Promise<DoneReason | undefined> {
  const { context, stopReason, running, reply } = params;

  if (context.signal.aborted) return 'interrupted';

  const limited = await firstOutcome({
    context,
    list: context.contributions.limit,
    input: { context, stopReason, running, reply },
  });

  if (limited) return limited.ended;

  // The last completion contribution always answers, so this is never undefined in practice.
  return (
    await firstOutcome({
      context,
      list: context.contributions.completion,
      input: { context, stopReason, running, reply },
    })
  )?.ended;
}

/** The first contribution of a list that takes the turn decides it; none: undefined. */
async function firstOutcome(params: {
  context: TurnContext;
  list: TurnContributions['limit'];
  input: LimitInput;
}): Promise<LimitOutcome | undefined> {
  const { context, list, input } = params;

  for (const contribution of list) {
    const { value } = await runContribution({
      contribution,
      input,
      signal: context.signal,
      report: reportContribution(context),
    });

    if (value) return value;
  }

  return undefined;
}

/**
 * Queues each result the moment its tool finishes, after the turn ended and `tool_batch`, so a
 * fast tool is never held back by a slow one called before it. A UI matches a result to its call
 * by id. History is returned in call order, which is what the model needs next. Every call gets a
 * result, real or "interrupted", so history stays valid.
 */
async function releaseResults(params: {
  running: RunningCall[];
  events: AgentEvents;
}): Promise<HistoryMessage[]> {
  const { running, events } = params;

  events.enqueue({ type: 'tool_batch', calls: running.map((r) => r.described) });

  // One synchronous pass, so a call is either already finished or waited for below, never both.
  // Finished ones go out first, in the order they finished; the rest as each one finishes.
  const early = running
    .flatMap(({ settled }) => (settled ? [settled] : []))
    .sort((a, b) => a.order - b.order);
  const late = running.filter(({ settled }) => !settled);

  for (const { outcome } of early) events.enqueue(outcome);

  // Enqueued as a settled value, not as the promise: the queue holds a pending item up and
  // everything behind it, which would put results back in call order.
  await Promise.all(
    late.map(async ({ outcome }) => {
      events.enqueue(await outcome);
    }),
  );

  const outcomes = await Promise.all(running.map((r) => r.outcome));

  return outcomes.map((o) => o.message);
}

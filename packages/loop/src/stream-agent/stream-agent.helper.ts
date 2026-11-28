import { whenAborted } from '../abort/abort.utils.js';
import { OrderedQueue } from '../queue/queue.service.js';
import { runOnError, runSessionStart } from '../hooks/hooks.helper.js';
import { createHookFailures } from '../hooks/hook-failures.helper.js';
import { approvalScreener, runSessionEnd } from '../hooks/new-points.helper.js';
import { StreamEndedError } from '../errors/loop.errors.js';
import { SessionError } from '@sheavly/runtime/errors/sessions.errors';
import { errorMessage } from '@sheavly/runtime/errors/errors.utils';
import { errorDetails } from '@sheavly/runtime/errors/error-details.utils';
import { redactDiagnosticText } from '@sheavly/core/text/diagnostic-text.utils';
import { SessionRegistry } from '@sheavly/runtime/sessions/sessions.service';
import type { RunSession } from '@sheavly/runtime/sessions/sessions.types';
import type {
  AgentOptions,
  RunAgentOptions,
  RunContext,
  TurnContext,
} from './stream-agent.types.js';
import { assertValidStoredHistory } from '../summary/checkpoint.utils.js';
import { runTurn } from './turn.helper.js';
import { buildContributions } from './turn-contributions.helper.js';
import { orderContributions } from './contributions.helper.js';
import { freezeUniqueTools } from './tool-names.utils.js';
import type { AgentEvent, AgentEventBody, DoneReason } from '@sheavly/protocol/event/event.types';
import type { HistoryMessage } from '@sheavly/protocol/history/history.types';
import type { ItemEvent } from '@sheavly/protocol/item/item.types';
import type { RunOutcome } from '@sheavly/protocol/session/session.types';

/**
 * Runs the agent and yields one typed, sequenced event per step.
 *
 * Every run is a session: the one in `options.session` (a sub-agent's, from its parent), or a
 * new main session. The session is ended with the run's outcome, and `done` names it.
 *
 * Aborting `signal` stops the run cleanly: the model stream is dropped, unfinished tools are
 * cancelled and recorded as interrupted, and the run ends with `done` (reason "interrupted").
 * It never throws because of an abort. Stopping iteration early (`break`) aborts the same way.
 */
export async function* streamAgent(options: AgentOptions): AsyncGenerator<AgentEvent> {
  const stop = new AbortController();
  const signal = options.signal ? AbortSignal.any([options.signal, stop.signal]) : stop.signal;
  const session = options.session ?? mainSession();
  // Each event joins the session tree's combined stream as it is released, with its `seq`.
  const events = new OrderedQueue<AgentEventBody>({
    onRelease: (event) => session.registry.publish({ sessionId: session.ref.id, event }),
  });

  // Items are told at once, beside the events and never through their queue (its `seq` has no gaps).
  const publishItem = (event: ItemEvent) =>
    session.registry.publishItem({ sessionId: session.ref.id, event });

  drive({ options, session, signal, aborted: whenAborted(signal), events, publishItem }).then(
    () => events.close(),
    (caughtError: unknown) => {
      // A session its registry doesn't know (the run's first check) has nothing to end.
      if (session.registry.get(session.ref.id)) {
        finishSession({ session, outcome: 'failed', keep: options.keepSession });
      }

      events.fail(caughtError);
    },
  );

  try {
    yield* events;
  } finally {
    stop.abort(); // no-op if the run already finished
  }
}

/** Convenience wrapper: runs to completion and returns the conversation. */
export async function runAgent(options: RunAgentOptions): Promise<HistoryMessage[]> {
  return (await runSession(options)).messages;
}

/** Runs to completion and returns how the run ended and the conversation (e.g. a sub-agent's). */
export async function runSession(
  options: RunAgentOptions,
): Promise<{ reason: DoneReason; messages: HistoryMessage[] }> {
  let ended: { reason: DoneReason; messages: HistoryMessage[] } | undefined;

  // Reads on past `done`, which is always the last event: a failed run's `done` comes before its
  // error, and returning there would swallow the error the caller must see.
  for await (const event of streamAgent(options)) {
    options.onEvent?.(event);
    if (event.type === 'done') ended = { reason: event.reason, messages: event.messages };
  }

  if (ended) return ended;

  throw new StreamEndedError();
}

/** A run with no session given is a main session, in a registry of its own. */
function mainSession(): RunSession {
  const registry = new SessionRegistry();

  return { registry, ref: registry.startMain({ title: 'Main session' }) };
}

/** The loop itself: call the model, run requested tools, feed results back, repeat. */
async function drive(given: RunContext) {
  const { session, events, signal } = given;
  const { maxTurns = Infinity } = given.options;
  // Hooks are ordered once, inside the `try` below, by their `after`: every runner reads that
  // list. Until then (and if ordering fails) `onError` hooks get the list as given, so a bad
  // `after` fails the run the way any other failure does, with `run_failed` and its one `done`.
  let hooks = given.options.hooks ?? [];
  const options = given.options;
  const messages = [...options.messages];
  const outputRecovery: TurnContext['outputRecovery'] = {
    attempts: 0,
    fruitless: 0,
    pending: undefined,
  };
  const summaryFailures = { count: 0, overflowTried: false };
  const connectionLosses = { inARow: 0 };
  const hookFailures = createHookFailures(events);
  // Set when a turn ends the run; still unset only if the turn cap ran out first.
  let reason: DoneReason | undefined;

  // Every event is published to the session's registry as it is released, mid-turn: a session
  // that registry doesn't know fails the run here, before anything ran, not halfway through.
  if (!session.registry.get(session.ref.id)) {
    throw new SessionError({
      reason: 'unknown_session',
      sessionId: session.ref.id,
      message: `Session ${session.ref.id} isn't in the registry the run was given`,
    });
  }

  let stopScreening: (() => void) | undefined;

  try {
    // Ordered and checked before anything runs, so a miswired hook or phase fails before the
    // first model call, through the failure path below.
    hooks = orderContributions(given.options.hooks ?? []);

    // The spread reads the `tools` getter once; that list is checked like the hooks (a clash fails
    // the run before the first model call) and the run goes on with a frozen copy of it, so
    // the check holds for the whole run, not just at its start.
    const read = { ...given.options, hooks };
    const context: RunContext = {
      ...given,
      options: { ...read, tools: freezeUniqueTools(read.tools) },
    };

    const contributions = buildContributions(context.options);

    // Hooks screen this session's approvals for the life of the run, and only its own.
    stopScreening = options.approvals?.screen(
      approvalScreener({ hooks, sessionId: session.ref.id, onHookError: hookFailures.report }),
    );

    // A history read from disk may hold a damaged checkpoint: fail before the first model call
    // (only `onError` hooks run, with the history as it is).
    assertValidStoredHistory(messages);

    // Once per session: a resumed one (a conversation's next prompt) already ran these.
    if (!options.resumed) {
      await runSessionStart({
        hooks,
        messages,
        signal,
        onContext: (added) => events.enqueue({ type: 'context_added', ...added }),
        onHookError: hookFailures.report,
      });
    }

    for (let turn = 1; turn <= maxTurns; turn++) {
      const ended = await runTurn({
        ...context,
        turn,
        messages,
        outputRecovery,
        connectionLosses,
        summaryFailures,
        hookFailures,
        contributions,
      });

      // Each turn's work is recorded as it happens, not only when the run ends.
      options.keepHistory?.(messages);

      // A follow-up can arrive while runTurn resolves its final async task check. Do not close
      // normal completion with accepted input still waiting in the inbox.
      const followedUp = ended === 'completed' && session.registry.hasMessages(session.ref.id);

      if (ended && !followedUp) {
        reason = ended;
        break;
      }

      // Backpressure: the next model call waits until the consumer has handled this turn,
      // so anything it does in response (swap provider, steer, abort) applies to the next turn.
      await events.consumed();
    }
  } catch (caughtError) {
    await runOnError({
      hooks,
      error: caughtError,
      messages,
      onHookError: hookFailures.report,
    });
    events.enqueue({
      type: 'run_failed',
      error: redactDiagnosticText(errorMessage(caughtError)),
      details: errorDetails(caughtError),
      session: session.ref,
    });
    // Release the diagnostic first, even when earlier tool results or error hooks were queued.
    await events.consumed();
    await runSessionEnd({
      hooks,
      outcome: 'failed',
      messages,
      signal,
      onHookError: hookFailures.report,
    });
    // The run still ends with its one `done`, so a stream is self-describing: tasks are stopped and
    // the session leaves `running` before it, as on every other path. The registry may no longer
    // know the session, which must not cost the `done`. The original exception still reaches
    // callers, after the stream has yielded `done`.
    if (signal.aborted) await options.tasks?.cancelSession(session.ref.id);

    if (session.registry.get(session.ref.id)) {
      finishSession({ session, outcome: 'failed', keep: options.keepSession });
    }

    events.enqueue({ type: 'done', reason: 'failed', messages, session: session.ref });
    throw caughtError;
  } finally {
    // Task controllers are independent of tool calls. Abort must stop them before the session
    // ends, including sub-agents whose own cleanup cancels their descendants. Only this session's:
    // the registry is shared by the run's sessions, so a stopped child leaves its parent's alone.
    if (signal.aborted) await options.tasks?.cancelSession(session.ref.id);
    stopScreening?.();
  }

  const outcome = reason ?? 'max_turns';

  // Before `done`, which must stay the last event: a failing sessionEnd hook is reported ahead of it.
  await runSessionEnd({ hooks, outcome, messages, signal, onHookError: hookFailures.report });
  finishSession({ session, outcome, keep: options.keepSession });
  events.enqueue({ type: 'done', reason: outcome, messages, session: session.ref });
}

/** The run is over: its session ends, or, kept for a conversation's next prompt, goes idle. */
function finishSession(params: {
  session: RunSession;
  outcome: RunOutcome;
  keep: boolean | undefined;
}): void {
  const { session, outcome, keep } = params;

  if (keep) session.registry.idle({ id: session.ref.id, outcome });
  else session.registry.end({ id: session.ref.id, state: outcome });
}

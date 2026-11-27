import { now } from '@sheavly/core/clock/clock.helper';
import { SessionError } from '@sheavly/runtime/errors/sessions.errors';
import type { AgentEvent } from '@sheavly/protocol/event/event.types';
import type { HistoryMessage } from '@sheavly/protocol/history/history.types';
import type { Message } from '@sheavly/protocol/message/message.types';
import { ConversationRunError } from '../errors/conversation.errors.js';
import { WAKE_AFTER_YIELD_MS } from './conversation.constants.js';
import type { Conversation, ConversationOptions } from './conversation.types.js';
import { canMoveRun } from './conversation.utils.js';
import { mintMessageId } from './message-id.helper.js';

/** A run that is going: what ends it, what yields it, and what stops it once its loop runs. */
type RunControls = {
  /** Ends the run: the caller's signal and a close, and its own stop once its loop runs. */
  signal: AbortSignal;
  /** Aborted by `yieldPrompt`: the run ends at its next completion point. */
  yielding: AbortController;
  /** Stops the run; none until its loop runs, so a stop before that is its caller's to make. */
  stop: (() => void) | undefined;
  /** Settles once the run has ended and the conversation decided what comes next. */
  ended: PromiseWithResolvers<undefined>;
};

type ActiveRun = RunControls & { state: 'prompt' | 'wake' };

/** What a conversation runs now: one run at a time, or none. */
type CurrentRun = { state: 'idle' } | ActiveRun;

/**
 * A conversation on the harness's main session. Every prompt runs `options.run` (the loop's
 * `streamAgent`) on the history so far with `keepSession`, so the session goes idle between
 * prompts instead of ending, and the next prompt resumes it. A prompt ends when the model
 * finishes, even while background work runs; only `await_tasks` holds it. Finite work that
 * finishes while the conversation is idle makes it start a run itself (`wake`) to deliver the
 * notice, however many times in a row unless the app sets `maxConsecutiveWakes`; services never
 * wake it.
 * An interrupted prompt leaves history valid to continue from; a failed one keeps the completed
 * work and the user's prompt too.
 */
export function createConversation(options: ConversationOptions): Conversation {
  const { harness, run, tools, hooks = [] } = options;
  const { sessions, mainSession, tasks, provider } = harness;
  /** Stops the running prompt when the conversation closes. */
  const closing = new AbortController();
  let messages: HistoryMessage[] = [...(options.messages ?? [])];
  let started = options.resumed ?? false;
  /** What runs now; it changes only through `moveRun`. */
  let ongoing: CurrentRun = { state: 'idle' };
  /** Runs `wake` started since the user's last prompt. */
  let wakesInRow = 0;
  const maxWakes = options.maxConsecutiveWakes ?? Infinity;
  /** Set by a stop, cleared by the next prompt: no run starts itself meanwhile. */
  let wakesSuppressed = false;
  /**
   * Set while a queued line waits to start or a prompt prepares its skills (`deferWakes`): that
   * prompt delivers what finished instead.
   */
  let wakesDeferred = false;
  /** The pending wake after a yielded run, until it fires or a prompt, stop or close drops it. */
  let yieldWake: ReturnType<typeof setTimeout> | undefined;

  function cancelYieldWake(): void {
    clearTimeout(yieldWake);
    yieldWake = undefined;
  }

  /** Set by the first close(): the cleanup every close() call waits for. */
  let closed: Promise<void> | undefined;

  /** Moves the run to `next`, refusing a move `CONVERSATION_RUN_TRANSITIONS` does not have. */
  function moveRun(next: CurrentRun): void {
    if (!canMoveRun({ from: ongoing.state, to: next.state })) {
      throw new ConversationRunError({ from: ongoing.state, to: next.state });
    }

    ongoing = next;
  }

  function refuse(params: { reason: 'session_running' | 'session_ended'; why: string }): never {
    const { reason, why } = params;

    throw new SessionError({ reason, sessionId: mainSession.id, message: why });
  }

  /**
   * One prompt's events. Its run is driven here, not just passed through: if the caller stops
   * iterating early, the prompt is stopped like an interrupt and its run is drained to its `done`,
   * so its history is kept and the session is idle again before the next `send`.
   */
  async function* prompt(params: {
    /** The user's prompt; none for a wake, which continues from the history with a notice. */
    user: Message | undefined;
    resumed: boolean;
    /** The run this is, already moved to: it ends idle here, however it ends. */
    current: ActiveRun;
  }): AsyncGenerator<AgentEvent> {
    const { user, current } = params;
    const stop = new AbortController();
    const signal = AbortSignal.any([stop.signal, closing.signal, current.signal]);
    const startingMessages = user ? [...messages, user] : [...messages];

    current.signal = signal;
    current.stop = () => stop.abort();
    // The longest history handed to `keepHistory` so far: it only grows, so if the run ends before
    // `done` or `onError` gave us one (it failed before its first turn), this is the truth, and
    // it holds the prompt that was already recorded.
    let latest: readonly HistoryMessage[] = startingMessages;
    const events = run({
      provider,
      tools,
      // The user's hooks, unchanged: a failed run's history comes from its `done` event.
      hooks,
      approvals: harness.approvals,
      messages: startingMessages,
      signal,
      tasks,
      session: { registry: sessions, ref: mainSession },
      keepSession: true,
      // Only `await_tasks` holds the main session open; other finished work wakes it (`wake`).
      holdOpenFor: 'awaited',
      keepHistory: (kept) => {
        latest = kept;
        options.keepHistory?.(kept);
      },
      yieldSignal: current.yielding.signal,
      resumed: params.resumed,
      instructions: options.instructions ?? harness.instructions,
      ...(options.maxTurns !== undefined && { maxTurns: options.maxTurns }),
      ...(options.summary && { summary: options.summary }),
    })[Symbol.asyncIterator]();
    let completed = false;
    const record = (event: AgentEvent) => {
      if (event.type !== 'done') return;
      messages = event.messages;
      completed = event.reason === 'completed';
    };
    let finished = false;

    // The user's prompt is recorded before the run, so a crash mid-run does not lose it.
    if (user) options.keepHistory?.(startingMessages);

    try {
      for (let next = await events.next(); !next.done; next = await events.next()) {
        record(next.value);
        yield next.value;
      }

      finished = true;
    } finally {
      // Stopped before its end (the caller broke off, or the run threw): stop it and read the rest.
      if (!finished) {
        stop.abort();

        for (let next = await events.next(); !next.done; next = await events.next()) {
          record(next.value);
        }
      }

      moveRun({ state: 'idle' });
      // What follows is synchronous, so a waiter resumes only after the history is kept and the
      // wake is decided; resolving first means a hook that throws below cannot strand it.
      current.ended.resolve(undefined);

      if (messages.length < latest.length) messages = [...latest];

      // Provider failures do not undo tool effects, so their completed work must stay in history.
      options.keepHistory?.(messages);

      // Work that finished as this run ended found it still running: its notice is waiting now.
      // Only after a run that completed: a stopped or failed one must not restart itself (its
      // cancelled work leaves notices behind). A yielded run gives the line the user queued
      // behind it a moment to arrive as the next prompt, then wakes if none did.
      // No `return` here: it would swallow the error of a run that threw.
      if (finished && completed && current.yielding.signal.aborted) {
        yieldWake = setTimeout(wake, WAKE_AFTER_YIELD_MS);
        yieldWake.unref();
      } else if (finished && completed) {
        wake();
      }
    }
  }

  /**
   * Continues the idle main session when finite work has finished: starts a run on the history
   * with no new prompt, and the loop delivers the notice before its first model call. The run's
   * events reach every UI through the combined stream, since no caller iterates them here. Does
   * nothing while a prompt runs (its own loop delivers), before the first prompt, or once closed.
   */
  function wake(): void {
    if (closed || ongoing.state !== 'idle' || !started || closing.signal.aborted) return;
    // A stop, or a prompt about to start (queued or preparing) that delivers the notice, holds it.
    if (wakesSuppressed || wakesDeferred) return;

    try {
      if (!tasks.hasWakingDeliveries(mainSession.id)) return;

      // Checked only once a notice waits, so the app hears of a wake that was refused, not of
      // every settlement.
      if (wakesInRow >= maxWakes) {
        options.onWakeCapped?.(maxWakes);

        return;
      }

      sessions.resume(mainSession.id);
      wakesInRow++;
      const woken: ActiveRun = {
        state: 'wake',
        signal: closing.signal,
        yielding: new AbortController(),
        stop: undefined,
        ended: Promise.withResolvers<undefined>(),
      };

      // Before the run moves, so nothing here can leave the conversation in a wake that never ends.
      noteWakeStarted();
      moveRun(woken);
      void drain(prompt({ user: undefined, resumed: true, current: woken }));
    } catch (caughtError) {
      // Nothing awaits a wake, so a refusal (an ended session) or a throwing `onWakeCapped` goes
      // to the app, not the process. Keep that call inside the try: a throw out of `wake` would
      // reject the settle loop and end every later wake. Each throws before the run moves.
      options.onWakeFailure?.(caughtError);
    }
  }

  /**
   * Says on the main agent's channel that a wake started a run, so the channel reads the run from
   * its start. Called before the run is drained: its events come only once the generator is
   * iterated, so none can reach the channel ahead of this entry. The wake goes on from the last
   * prompt, so it names that prompt's message and has no text.
   */
  function noteWakeStarted(): void {
    const node = sessions.nodeIdOf(mainSession.id);
    const messageId = sessions.messageOf(mainSession.id);

    if (node === undefined || messageId === undefined) return;

    harness.nodeChannels?.noteRunStarted({ node, cause: 'wake', messageId });
  }

  /**
   * Asks a running wake to end at its completion point and waits for it, so a prompt can start.
   * The ended wake is a yielded run: it wakes again after a short grace only if no prompt came.
   */
  async function settleWake(): Promise<void> {
    if (ongoing.state !== 'wake') return;
    ongoing.yielding.abort();
    await ongoing.ended.promise;
  }

  /**
   * Runs a prompt nobody iterates to its end. UIs already see a failure in the stream
   * (`run_failed`); there is no caller to throw to, so the app is told through `onWakeFailure`.
   */
  async function drain(events: AsyncIterable<AgentEvent>): Promise<void> {
    try {
      for await (const _event of events);
    } catch (caughtError) {
      options.onWakeFailure?.(caughtError);
    }
  }

  /**
   * The run goes back to idle only when the prompt's run ends, which needs someone to iterate it. A
   * stream that closed before it was read (the SSE callback never ran) is drained here once it is
   * stopped, so the conversation is not left running for good. A stop that came before `send`
   * leaves the prompt to its caller: it ends as interrupted when read.
   */
  function endIfNeverIterated(params: {
    events: AsyncGenerator<AgentEvent>;
    signal: AbortSignal;
  }): AsyncIterable<AgentEvent> {
    const { events, signal } = params;
    let iterated = false;

    signal.addEventListener(
      'abort',
      () => {
        if (!iterated) void drain(events);
      },
      { once: true },
    );

    return {
      [Symbol.asyncIterator]() {
        iterated = true;

        return events;
      },
    };
  }

  /** Every settlement may have made a notice ready for an idle session. */
  async function wakeOnSettled(): Promise<void> {
    while (!closing.signal.aborted) {
      await tasks.nextSettled(closing.signal);
      wake();
    }
  }

  void wakeOnSettled();

  return {
    send(text, sendOptions = {}) {
      if (closed) {
        refuse({ reason: 'session_ended', why: 'This conversation is closed; start a new one' });
      }

      if (ongoing.state !== 'idle') {
        refuse({
          reason: 'session_running',
          why: 'A prompt is still running in this conversation: wait for it to finish, or stop it, before sending the next',
        });
      }

      // The main session runs from its start; every later prompt resumes it from idle.
      const messageId = sendOptions.messageId ?? mintMessageId();

      sessions.setMessage({ sessionId: mainSession.id, messageId });
      wakesInRow = 0;
      wakesSuppressed = false;
      cancelYieldWake();
      // A caller aborting its own prompt is a stop too, whoever calls it. A signal already
      // aborted (a stop during preparation) never fires its listener, so it is checked here.
      if (sendOptions.signal?.aborted) wakesSuppressed = true;
      sendOptions.signal?.addEventListener('abort', () => (wakesSuppressed = true), { once: true });
      const resumed = started;

      if (resumed) sessions.resume(mainSession.id);
      started = true;
      const signal = AbortSignal.any([
        closing.signal,
        ...(sendOptions.signal ? [sendOptions.signal] : []),
      ]);
      const current: ActiveRun = {
        state: 'prompt',
        signal,
        yielding: new AbortController(),
        stop: undefined,
        ended: Promise.withResolvers<undefined>(),
      };

      moveRun(current);
      const user: Message = {
        role: 'user',
        id: messageId,
        origin: 'user',
        content: text,
        ...(sendOptions.parts && { parts: sendOptions.parts }),
        at: now(),
      };

      return endIfNeverIterated({ events: prompt({ user, resumed, current }), signal });
    },
    yieldPrompt() {
      if (closed) {
        refuse({ reason: 'session_ended', why: 'This conversation is closed; start a new one' });
      }

      if (ongoing.state === 'idle' || ongoing.signal.aborted) return false;
      ongoing.yielding.abort();

      return true;
    },
    settleWake,
    async whenIdle() {
      if (ongoing.state !== 'idle') await ongoing.ended.promise;
    },
    deferWakes(defer) {
      wakesDeferred = defer;
      // Work that finished while a line waited would otherwise wait for the next settlement.
      if (!defer) wake();
    },
    stop() {
      // The user stopped this, running or not: finished work waits for their next prompt instead
      // of restarting it.
      wakesSuppressed = true;
      cancelYieldWake();

      if (ongoing.state === 'idle' || !ongoing.stop) return false;
      ongoing.stop();

      return true;
    },
    get messages() {
      return messages;
    },
    get running() {
      return ongoing.state !== 'idle';
    },
    get state() {
      return ongoing.state;
    },
    close() {
      // Every call waits for the same cleanup: a second close() never resolves before it's done.
      closed ??= (async () => {
        cancelYieldWake();
        closing.abort();
        await tasks.cancelAll();

        const session = sessions.get(mainSession.id);

        sessions.end({
          id: mainSession.id,
          state: session?.state === 'idle' ? (session.lastOutcome ?? 'completed') : 'interrupted',
        });
      })();

      return closed;
    },
  };
}

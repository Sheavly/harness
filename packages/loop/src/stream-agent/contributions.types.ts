import type { DoneReason } from '@sheavly/protocol/event/event.types';
import type { HistoryMessage } from '@sheavly/protocol/history/history.types';
import type { Message, TurnStopReason } from '@sheavly/protocol/message/message.types';
import type { TaskInfo } from '@sheavly/protocol/task/task.types';
import type { RunningCall, TurnContext } from './stream-agent.types.js';

/**
 * One named piece of a turn phase. `after` orders it among the phase's other contributions;
 * `onFailure` says whether a throw fails the run or is reported (`hook_failed`) and skipped;
 * `abort` says whether the run's abort stops waiting for it (`race`) or it must finish (`wait`).
 */
export type Contribution<Input, Output> = {
  name: string;
  after?: readonly string[];
  onFailure: 'fail-run' | 'report';
  abort: 'race' | 'wait';
  run: (input: Input) => Output | Promise<Output>;
};

/** What one contribution gave back: a value, or nothing (aborted, or it failed and was reported). */
export type Ran<T> = { value: T | undefined };

/** What a model-view contribution gets and returns: the messages the model is about to see. */
export type ViewInput = { view: readonly Message[]; window: number | undefined };

/** A rejected call's context: a contribution returns true when it recovered and the turn retries. */
export type OverflowInput = {
  context: TurnContext;
  stopReason: TurnStopReason;
  /** The rejected call had already started tools: its history is not ours to rewind. */
  started: boolean;
};

/** A model call that failed after its reply started: a contribution returns true when it can go on from what was kept. */
export type DropInput = { context: TurnContext; error: unknown };

/** What a finished turn knows: a contribution returns why the run ends, or undefined to go on. */
export type LimitInput = {
  context: TurnContext;
  stopReason: TurnStopReason;
  running: readonly RunningCall[];
  reply: HistoryMessage;
};

/** A limit contribution that took the turn: why the run ends, or undefined to go on. */
export type LimitOutcome = { ended: DoneReason | undefined };

/**
 * What a turn's delivery steps share: where the notices of this turn start in history, and the
 * tasks each delivery of finished work carried. Set by the step that knows it, read by later ones.
 */
export type DeliveryState = { noticesFrom: number; tasks: TaskInfo[][] };

/** What a delivery step gets: the turn, and what earlier steps of this turn recorded. */
export type DeliveryInput = { context: TurnContext; state: DeliveryState };

/**
 * The turn's features, by phase and in order. A feature absent from a list is absent from the
 * turn: nothing in `runTurn` tests an option to decide.
 */
export type TurnContributions = {
  /**
   * Make room before the turn's hooks and model call (the threshold summary). A contribution
   * returns `'full'` when nothing could shrink a context that fills the window: the run then ends
   * `context_window_exceeded`. First answer wins; none registered means no room is made.
   */
  room: readonly Contribution<TurnContext, 'full' | undefined>[];
  /** Start of a turn: what reaches history before any hook runs (steering, finished work, failures). */
  delivery: readonly Contribution<DeliveryInput, void>[];
  /** Reshape the view the model is sent for one call (never stored history). */
  view: readonly Contribution<ViewInput, readonly Message[]>[];
  /** After a rejected (too long) call: recover and retry. The first to return true wins. */
  overflow: readonly Contribution<OverflowInput, boolean>[];
  /**
   * After a call failed with the reply half sent (a lost connection): keep what arrived and go on,
   * or fail the run with the error. The first to return true wins.
   */
  dropped: readonly Contribution<DropInput, boolean>[];
  /** After a turn's results: recover from the stop reason, or end the run. First answer wins. */
  limit: readonly Contribution<LimitInput, LimitOutcome | undefined>[];
  /**
   * After the limits: does the run end now? In order: running tools, the inbox, a yield, waiting
   * on awaited work, and last the answer that always takes the turn. First answer wins.
   */
  completion: readonly Contribution<LimitInput, LimitOutcome | undefined>[];
};

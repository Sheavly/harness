import type { ModelConnection } from '@sheavly/protocol/connection/connection.types';
import type { EntryEvent } from '@sheavly/protocol/event/event.types';
import type { CallId } from '@sheavly/protocol/message/message.types';
import type { SessionId } from '@sheavly/protocol/session/session.types';
import type { TaskId } from '@sheavly/protocol/task/task.types';
import type { FileEdit } from '../changes/changes.types.js';
import type { Failure } from '../failures/failures.types.js';

/** A tool call that has started and not yet returned: what the working indicator shows live. */
export type RunningTool = {
  id: CallId;
  /** The model's description of the call. */
  description: string;
  /** When its start was seen, in epoch milliseconds. */
  startedAt: number;
};

/** What the latest collapsed line under a step stands for, which Ctrl+O expands. */
export type Expandable = 'change' | 'failure';

/** What a finished tool call is drawn as, and which collapsed line (if any) is newly the latest. */
export type ToolResultLines = { lines: string[]; latest: Expandable | undefined };

/** Where a terminal front end's output goes (stdout, or stdout plus a log file). */
export type Write = (text: string) => void;

/**
 * Where the model's reply goes, apart from the rest of the run's output: a screen that draws
 * Markdown needs to know where the reply ends, since a block is only drawn once it is complete.
 * `end` says no more of this reply is coming.
 */
export type ReplySink = { write: Write; end: () => void };

/** What the last thing written was: the model's reply text, or anything else the run did. */
export type Section = 'reply' | 'activity';

/** The sub-agent a line is about: its title and id, and the indent for how deep it is. */
type SubAgent = { indent: string; title: string; id: SessionId };

/**
 * How a conversation's events read on screen. The `Renderer` decides what to show and in what
 * order; a look decides the words, symbols and colours. Every method returns the text to write,
 * `''` for nothing. `gap` separates one section from the one before it.
 */
export type Look = {
  /** What goes between two sections, so a reply and the tool lines don't run together. */
  gap: (params: { from: Section | undefined; to: Section; lineOpen: boolean }) => string;
  /**
   * Whether a step of a batch is written with its result, in call order, instead of when it
   * starts: the results of a batch come after all its starts, so a person would read each under
   * the wrong title. A log read by a script keeps the start order (false).
   */
  pairSteps: boolean;
  toolStarted: (params: { description: string; command: string | undefined }) => string;
  parallel: (count: number) => string;
  toolResult: (params: { ok: boolean; label: string; detail: string; seconds: string }) => string;
  /** A file change, under its result: a line standing for its diff, which a person expands. */
  fileChange: (edit: FileEdit) => string;
  /** A failed step's message that says more than its line, under its result, as `fileChange`. */
  failure: (failure: Failure) => string;
  taskRunning: (params: { label: string; id: TaskId }) => string;
  taskCompleted: (params: {
    ok: boolean;
    id: TaskId;
    status: string;
    exit: string;
    elapsed: string;
    command: string;
    output: string;
  }) => string;
  steer: (firstLine: string) => string;
  contextAdded: (params: { hook: string; chars: number }) => string;
  modelInputChanged: (params: {
    hook: string;
    added: number;
    removed: number;
    edited: number;
  }) => string;
  summaryStarted: () => string;
  summaryDone: (params: { tokensBefore: number; tokensAfter: number }) => string;
  /** `cancelled` is a summary stopped by the person, which needs no word of its own. */
  summaryFailed: (params: { error: string; cancelled: boolean }) => string;
  runFailed: (error: string) => string;
  hookFailed: (params: { hook: string; handler: string; error: string }) => string;
  storageFailed: (error: string) => string;
  /** A model call waiting for the network or retrying its provider, or through again (`restored`). */
  modelConnection: (connection: ModelConnection) => string;
  /** An extension's event as its plain-text fallback, one line; never chosen by the event's kind. */
  extensionEvent: (params: { extension: string; text: string }) => string;
  turnEnd: (params: {
    stopReason: Extract<EntryEvent, { type: 'turn_end' }>['stopReason'];
  }) => string;
  /** The run is held open on `await_tasks`, with this many grouped tasks still running. */
  awaitingTasks: (count: number) => string;
  done: (params: {
    reason: Extract<EntryEvent, { type: 'done' }>['reason'];
    events: number;
    reasoning: number;
  }) => string;
  subAgentStarted: (params: SubAgent & { depth: number; parent?: string; root?: string }) => string;
  subAgentStatus: (params: SubAgent & { status: string }) => string;
  subAgentMessage: (params: SubAgent & { from: string; content: string }) => string;
  subAgentEnded: (params: SubAgent & { state: string }) => string;
};

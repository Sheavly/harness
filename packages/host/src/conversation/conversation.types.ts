import type { Hook } from '@sheavly/core/hook/hook.types';
import type { Provider } from '@sheavly/core/provider/provider.types';
import type { SummaryOptions } from '@sheavly/core/summary/summary.types';
import type { Tool } from '@sheavly/core/tool/tool.types';
import type { RunSession } from '@sheavly/runtime/sessions/sessions.types';
import type { TaskRegistry } from '@sheavly/runtime/tasks/tasks.service';
import type { ApprovalRegistry } from '@sheavly/runtime/approvals/approvals.service';
import type { AgentEvent } from '@sheavly/protocol/event/event.types';
import type { HistoryMessage } from '@sheavly/protocol/history/history.types';
import type { PromptPart } from '@sheavly/protocol/message/message.types';
import type { Harness } from '../host/host.types.js';

/**
 * Runs one prompt of a conversation and yields its events. The UI passes the loop's
 * `streamAgent` here (the host doesn't depend on the loop).
 */
export type RunPrompt = (options: {
  provider: Provider;
  tools: Tool[];
  hooks: Hook[];
  /** Lets the hooks' `approval` handlers see this session's requests before a UI does. */
  approvals: ApprovalRegistry;
  messages: HistoryMessage[];
  signal: AbortSignal;
  tasks: TaskRegistry;
  session: RunSession;
  keepSession: true;
  /** Given the whole history after every turn, so a long run is stored as it goes. */
  keepHistory: (messages: readonly HistoryMessage[]) => void;
  /** Aborted by `Conversation.yieldPrompt`: end as completed at the next completion point. */
  yieldSignal: AbortSignal;
  /** Only grouped (`await_tasks`) work holds the main session open; the rest wakes it later. */
  holdOpenFor: 'awaited';
  /** Every prompt after the first: the session already ran its `sessionStart` hooks. */
  resumed: boolean;
  instructions?: string;
  maxTurns?: number;
  summary?: SummaryOptions;
}) => AsyncIterable<AgentEvent>;

/** What a conversation runs every prompt with: the UI's choices, as for a single run. */
export type ConversationOptions = {
  /** The shared services: its main session is the conversation's. */
  harness: Harness;
  run: RunPrompt;
  tools: Tool[];
  hooks?: Hook[];
  /** Complete override of harness instructions; an empty string intentionally omits them. */
  instructions?: string;
  maxTurns?: number;
  /** Summarize the history when the context nears the window; passed to every prompt's run. */
  summary?: SummaryOptions;
  /**
   * The history to continue from (default: none), e.g. a conversation saved earlier: its first
   * prompt runs on it, in this harness's new session.
   */
  messages?: HistoryMessage[];
  /**
   * Starts as a conversation whose session already ran: its first prompt resumes the main
   * session instead of starting it (a reopened conversation, whose `sessionStart` hooks already
   * added their context to `messages`).
   */
  resumed?: boolean;
  /**
   * Told the history when a prompt starts (previous finished history plus this prompt), then
   * when it ends or fails (completed work included). It must not throw or wait: a caller queues writes and reports failures its own way.
   */
  keepHistory?: (messages: readonly HistoryMessage[]) => void;
  /**
   * Told when the run the conversation started itself for finished work fails: no caller iterates
   * it, so this is where the app logs it. Must not throw.
   */
  onWakeFailure?: (error: unknown) => void;
  /**
   * How many runs in a row the conversation may start itself for finished work without a user
   * prompt between them. Unset means no limit, as for any unattended work; past a limit, notices
   * wait for the next prompt and `onWakeCapped` is told.
   */
  maxConsecutiveWakes?: number;
  /**
   * Told, with the limit, whenever finished work finds the conversation at `maxConsecutiveWakes`
   * and so cannot wake it, so the app can say the notice waits for the user. It repeats while that
   * notice waits (each settlement and each run end asks again), so an app that shows it should do
   * so once. Must not throw: an error goes to `onWakeFailure`, as for a failed wake run.
   */
  onWakeCapped?: (limit: number) => void;
};

/**
 * What a conversation runs now: nothing (`idle`), a user's prompt, or a run it started itself to
 * deliver finished work (`wake`). One at a time; the moves are `CONVERSATION_RUN_TRANSITIONS`.
 */
export type ConversationRunState = 'idle' | 'prompt' | 'wake';

/**
 * One conversation the user keeps talking to: each prompt continues from the history so far, in
 * the same session, which is idle between prompts and ends only on `close`.
 */
export type Conversation = {
  /**
   * Runs `prompt` as the next turn of the conversation and yields its events; iterate it to the
   * end (or abort `signal`, or stop iterating, to stop the prompt). Throws a `SessionError`
   * (`session_running`) while another prompt runs, and (`session_ended`) once closed. `parts`
   * is what the user typed, when skills ran: it goes on the history's user message for a UI.
   */
  send: (
    prompt: string,
    options?: { signal?: AbortSignal; parts?: PromptPart[] | undefined },
  ) => AsyncIterable<AgentEvent>;
  /**
   * Asks the running prompt to end as completed at its next completion point, without waiting
   * for background tasks or sub-agents (their results stay for the next prompt). Nothing is
   * interrupted or steered. False when no prompt runs or it is stopping; throws `SessionError`
   * (`session_ended`) once closed.
   */
  yieldPrompt: () => boolean;
  /**
   * Stops the running prompt, or the run the conversation started itself for finished work; false
   * when nothing runs. Its history stays valid.
   */
  stop: () => boolean;
  /**
   * When the conversation started a run itself for finished work, asks it to end at its completion
   * point and resolves once it has, so the next prompt can be sent. Resolves at once otherwise.
   */
  settleWake: () => Promise<void>;
  /** The history so far: every finished prompt's, valid to continue from. */
  readonly messages: readonly HistoryMessage[];
  /** Whether a run is going now: a prompt, or one the conversation started itself. */
  readonly running: boolean;
  /** What runs now; it stays `idle` once closed, when no run is left. */
  readonly state: ConversationRunState;
  /**
   * Ends this live conversation: stops the running prompt, cancels its background tasks (and the
   * processes they run) and ends the session. Idempotent. It deletes nothing: `messages` stays
   * readable, and a new conversation can continue from it (`options.messages`).
   */
  close: () => Promise<void>;
};

import type { Provider } from '@sheavly/core/provider/provider.types';
import type { TaskRegistry } from '@sheavly/runtime/tasks/tasks.service';
import type { ApprovalRegistry } from '@sheavly/runtime/approvals/approvals.service';
import type { Tool } from '@sheavly/core/tool/tool.types';
import type { ContextState, Hook } from '@sheavly/core/hook/hook.types';
import type { ToolOutcome } from '../events/events.types.js';
import type { HookFailures, OnHookError } from '../hooks/hooks.types.js';
import type { TurnContributions } from './contributions.types.js';
import type { OrderedQueue } from '../queue/queue.service.js';
import type { ItemReason, PublishItem } from '../items/items.types.js';
import type { RunSession } from '@sheavly/runtime/sessions/sessions.types';
import type {
  AgentEvent,
  AgentEventBody,
  DescribedCall,
} from '@sheavly/protocol/event/event.types';
import type { HistoryMessage } from '@sheavly/protocol/history/history.types';
import type { Message, ToolMessage } from '@sheavly/protocol/message/message.types';
import type { SessionRef } from '@sheavly/protocol/session/session.types';
import type { HarnessNotice } from '@sheavly/protocol/notice/notice.types';
import type { SummaryOptions } from '@sheavly/core/summary/summary.types';

export type AgentOptions = {
  provider: Provider;
  tools: Tool[];
  /** The stored conversation: messages and any checkpoints. A model is sent `viewOf` it. */
  messages: HistoryMessage[];
  /**
   * Summarize the history when the context nears the window. Without it the loop never writes a
   * checkpoint (one already in `messages` is still applied to what the model sees).
   */
  summary?: SummaryOptions;
  /**
   * Called with the whole stored history after every turn (reply, tool results and any
   * checkpoint in it), so a long run is on disk as it goes and a search can find what it did.
   * History only grows between calls. Must return at once: the loop does not wait for it.
   */
  keepHistory?: (messages: readonly HistoryMessage[]) => void;
  /** Model calls before the run stops with `max_turns`. Without it a run goes on until it is done or stopped. */
  maxTurns?: number;
  /** Extra calls after output truncation, unlimited by default. Set to zero to stop immediately. */
  maxOutputContinuations?: number;
  /** The host's system instructions, sent with every model call (hooks may add more). */
  instructions?: string;
  signal?: AbortSignal;
  /**
   * This run's background tasks, delivered at turn boundaries. Abort cancels the whole registry,
   * including generic tasks and services: concurrent runs and parent/child loops must use
   * distinct registries. The sub-agent factory creates a separate registry for each child.
   */
  tasks?: TaskRegistry;
  /**
   * Customize the loop: add context before turns, wrap tool calls. Run in this order. A sub-agent
   * gets only the hooks its parent passes it.
   */
  hooks?: Hook[];
  /**
   * The registry this run's tools ask approvals from. With it, the hooks' `approval` handlers
   * see this session's requests before any UI does, for as long as the run lasts.
   */
  approvals?: ApprovalRegistry;
  /**
   * Which session this run is (from a `SessionRegistry`). Omit it and the run starts its own
   * main session with a fresh id. Either way the session is ended with the run's outcome.
   */
  session?: RunSession;
  /**
   * Keep the session open when the run finishes, however it ends: it goes idle (with how the run
   * ended as its `lastOutcome`) instead of ending, for a conversation's next prompt. The host
   * ends it when the conversation closes.
   */
  keepSession?: boolean;
  /**
   * Aborting it asks the run to end as `completed` at its next completion point instead of
   * waiting for background tasks or delivering their results; those stay pending for the next
   * run. It never interrupts a model call or running tools, and never steers the run.
   */
  yieldSignal?: AbortSignal;
  /**
   * What keeps the run open after the model finishes. `finite` (the default, a sub-agent's) holds
   * it for any running finite task, so the agent cannot end while its own work runs. `awaited`
   * (the main session's) holds it only for work grouped by `await_tasks`: other work finishes on
   * its own and its notice reaches the model at its next call. Services never hold a run.
   */
  holdOpenFor?: 'finite' | 'awaited';
  /**
   * This run continues a session an earlier run already started (a conversation's next prompt):
   * `sessionStart` hooks ran then and are not run again, so their context isn't added twice.
   */
  resumed?: boolean;
};

export type RunAgentOptions = AgentOptions & { onEvent?: (event: AgentEvent) => void };

/** The queue every loop event goes through, in causal order. */
export type AgentEvents = OrderedQueue<AgentEventBody>;

/** What one run shares with each of its turns. */
export type RunContext = {
  options: AgentOptions;
  /** The run's session: the one passed in, or a main session it started itself. */
  session: RunSession;
  signal: AbortSignal;
  /** Resolves when `signal` aborts. */
  aborted: Promise<void>;
  events: AgentEvents;
  /**
   * Tells the session registry an item of this run, at once. Items are beside the events and not
   * in their queue: they never reach the combined stream or the run's own iterator.
   */
  publishItem: PublishItem;
};

export type TurnContext = RunContext & {
  turn: number;
  /** Counts output-limit recoveries across the whole run, including tool turns. */
  outputRecovery: {
    attempts: number;
    /** Truncated replies in a row that kept no text and no tool call. */
    fruitless: number;
    pending: Extract<HarnessNotice, { kind: 'output-continuation' }> | undefined;
  };
  /** Model calls in a row a lost connection cut, whatever each kept (`MAX_LOST_CONNECTIONS_IN_A_ROW`). */
  connectionLosses: { inARow: number };
  /** The run's stored history; the turn appends to it, and a summary appends a checkpoint. */
  messages: HistoryMessage[];
  /**
   * Threshold summaries that failed in a row this run (at the policy's limit they stop), and
   * whether the current model call already got its one overflow summary.
   */
  summaryFailures: { count: number; overflowTried: boolean };
  /** The run's failed hook handlers: reported as they fail, told to the model at its next call. */
  hookFailures: HookFailures;
  /** The run's turn features, ordered once at its start (`buildContributions`). */
  contributions: TurnContributions;
};

/** A tool call that started while the model streamed, with its eventual outcome. */
export type RunningCall = {
  described: DescribedCall;
  outcome: Promise<ToolOutcome>;
  /**
   * Set the moment the tool finishes: its outcome and where it finished among the turn's calls
   * (0 first). Results that finished while the model still streamed are released in this order.
   */
  settled?: { order: number; outcome: ToolOutcome };
};

/** What a tool needs to start: the tools, hooks, task registry and its abort signal. */
export type ToolStart = {
  tools: Tool[];
  hooks?: Hook[] | undefined;
  tasks?: TaskRegistry | undefined;
  /** The run's session, passed on to tools (`context.session`). */
  session: SessionRef;
  signal: AbortSignal;
  /** Told about a tool hook that failed (`hook_failed`, and a notice to the model). */
  onHookError: OnHookError;
};

export type SampleContext = ToolStart & {
  provider: Provider;
  /** This turn's system instructions: the run's own plus what `beforeTurn` hooks added. */
  instructions?: string | undefined;
  /** The messages this call sends: the history, as `beforeModelCall` hooks changed it. */
  messages: readonly Message[];
  /** How full the context is for this call, read once by the turn. */
  state: ContextState;
  /** Recovery for this call only, never inserted into conversation history. */
  continuation: Extract<HarnessNotice, { kind: 'output-continuation' }> | undefined;
  /** Resolves when `signal` (the run's) aborts. */
  aborted: Promise<void>;
  events: AgentEvents;
  /** The ordinal of this model call in the run, which its tool calls' items carry. */
  turn: number;
  publishItem: PublishItem;
};

/** Why a tool was stopped before it settled, and the placeholder result it gets. */
export type ToolStop = { content: string; by: Extract<ItemReason, 'interrupted' | 'failed'> };

/** What starting a tool came to: its outcome and, when it was stopped, by whom. */
export type StartedTool = {
  outcome: ToolOutcome;
  /** The message of `outcome` as history holds it. */
  message: ToolMessage;
  stoppedBy?: ToolStop['by'];
};

/**
 * A failed model call: the error to fail the run with, after its started tools are recorded.
 * `stopTools` stops them: already done for any failure but a lost connection, whose tools are
 * left running in case the turn goes on from what arrived.
 */
export type SampleFailure = { error: unknown; stopTools: () => void };

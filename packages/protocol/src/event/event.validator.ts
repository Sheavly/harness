import { z } from 'zod';
import { modelConnectionSchema } from '../connection/connection.validator.js';
import { modelUsageSchema } from '../usage/usage.validator.js';
import { inboxMessageSchema, sessionRefSchema } from '../session/session.validator.js';
import { taskInfoSchema } from '../task/task.validator.js';
import { nodeIdSchema } from '../node/node.validator.js';
import { harnessNoticeSchema } from '../notice/notice.validator.js';
import {
  messageSchema,
  reasoningItemSchema,
  summarySectionIdSchema,
  toolCallSchema,
  turnStopReasonSchema,
} from '../message/message.validator.js';
import { historyMessageSchema } from '../history/history.validator.js';
import { RUN_OUTCOMES } from '../status/status.constants.js';
import {
  extensionEnvelopeShape,
  extensionQualifiedNameSchema,
} from '../extension/extension.validator.js';
import { isInNamespace } from '../extension/extension.utils.js';

/**
 * An extension's own event: an open envelope inside the closed union. `type` is fixed, but
 * `kind` (`<extension>.<name>`, in the sender's namespace) is any name, so a consumer that does
 * not know a kind still parses it, and shows `text` or skips it. `data` is the sender's
 * versioned JSON payload, and `text` its plain-text fallback. Live data for a UI; never model
 * input, and published outside any run (`seq` 0, like `storage_failed`). Exported so the
 * extension host can check an envelope with the schema the stream will read it with.
 */
export const extensionEventSchema = z
  .object({
    type: z.literal('extension_event'),
    ...extensionEnvelopeShape,
    kind: extensionQualifiedNameSchema,
  })
  .refine((event) => isInNamespace({ extension: event.extension, name: event.kind }), {
    message: 'kind must start with "<extension>."',
    path: ['kind'],
  });

/**
 * Data a tool returns for a UI, never for history (so it costs no tokens). `kind` names it
 * (`file_change`, `file_read`, ...); the tool that emits it defines the kind and the rest of its
 * shape, and a UI renders the kinds it knows and skips the others. The harness passes it through
 * hooks and onto the `tool_result` event without looking inside.
 */
export const toolArtifactSchema = z.looseObject({ kind: z.string() });

export const describedCallSchema = z.object({
  call: toolCallSchema,
  /** The model's plain-language note, e.g. "reading index.ts". */
  description: z.string(),
});

const errorCauseSchema = z.object({
  name: z.string(),
  message: z.string(),
  code: z.string().exactOptional(),
  reason: z.string().exactOptional(),
});

/** Selected diagnostic fields, not a serialized exception, request, response or headers. */
export const errorDetailsSchema = errorCauseSchema.omit({ message: true }).extend({
  stack: z.string().exactOptional(),
  causes: z.array(errorCauseSchema).max(4),
});

/** Why a summary ran: the context neared its window, a user asked, or a call overflowed it. */
const summaryReasonSchema = z.enum(['threshold', 'manual', 'overflow']);

/**
 * Why a summary failed: the summarizer or a hook did not produce one (`generation`), what it
 * produced would not keep the request, tool pairing or history valid (`preservation`), it was not
 * smaller than what it replaces (`size`), or the run was aborted (`cancellation`).
 */
const summaryFailureKindSchema = z.enum(['generation', 'preservation', 'size', 'cancellation']);

/** How the run ended: the same outcomes a session ends with, `failed` included. */
export const doneReasonSchema = z.enum(RUN_OUTCOMES);

/**
 * One step the loop took. Per turn, in causal order:
 *
 *   task_completed × N                            (background tasks that finished since last turn)
 *   → message_received × N                        (messages sent to this session meanwhile)
 *   → summary_started → summary_done | summary_failed  (when the context nears its window)
 *   → context_added × N                           (hooks' `beforeTurn` context, in hook order)
 *   → model_input_changed × N                     (hooks' `beforeModelCall` that changed the messages)
 *   → harness_notice                              (structured telemetry sent to this model call)
 *   → text_delta / reasoning / tool_call_started  (live, as the model streams)
 *   → turn_end
 *   → tool_batch → tool_result | task_running × N (after the turn, in finish order; match by call id)
 *   → next turn ... → done
 */
/** Every step but `done`: the events a run and the combined stream (`StreamEntry`) share. */
const stepEventSchemas = [
  /** Sent after cleanup, before the failed session update; never added to model history. */
  z.object({
    type: z.literal('run_failed'),
    error: z.string(),
    session: sessionRefSchema,
    details: errorDetailsSchema.exactOptional(),
  }),
  z.object({ type: z.literal('usage'), usage: modelUsageSchema }),
  /** The same data sent to the model, before its call; a UI decides whether and how to show it. */
  z.object({ type: z.literal('harness_notice'), notice: harnessNoticeSchema }),
  z.object({ type: z.literal('text_delta'), text: z.string() }),
  /** Opaque reasoning state; kept in history and resent automatically. */
  z.object({ type: z.literal('reasoning'), item: reasoningItemSchema }),
  /**
   * Live and content-free: the model started (`active: true`) or stopped reasoning, as its
   * provider could observe it. Never kept in history. A provider that can't observe reasoning
   * sends none, so a UI keeps its generic busy state rather than claiming the model thinks.
   */
  z.strictObject({ type: z.literal('reasoning_activity'), active: z.boolean() }),
  /**
   * Live: the model call waits for this machine's connection (`offline`) or retries a provider
   * that does not answer (`provider_unreachable`), and `restored` once it got through. A UI shows
   * the state until `restored`, the next turn's events or `done`. Never kept in history, and sent
   * before anything of the reply it belongs to.
   */
  z.strictObject({ type: z.literal('model_connection'), connection: modelConnectionSchema }),
  /** The model asked for a tool and it started running (concurrently with the rest of the turn). */
  describedCallSchema.extend({ type: z.literal('tool_call_started') }),
  z.object({
    type: z.literal('turn_end'),
    turn: z.number().int().nonnegative(),
    stopReason: turnStopReasonSchema,
  }),
  /** The turn ended with these calls, in the order the model made them; results follow as they finish. */
  z.object({ type: z.literal('tool_batch'), calls: z.array(describedCallSchema) }),
  /**
   * A tool's result, released only after the turn ended, in the order the tools finished (not
   * call order; history keeps call order).
   * `artifacts`: what the tool returned for a UI (a file diff, a read range, a parsed table),
   * passed on as the tool (or a hook) left them. A UI renders the kinds it knows.
   */
  describedCallSchema.extend({
    type: z.literal('tool_result'),
    message: messageSchema,
    durationMs: z.number(),
    artifacts: z.array(toolArtifactSchema).readonly().exactOptional(),
  }),
  /**
   * In place of `tool_result` when the call launched a background task: it's still running.
   * `nodeId` is the node the call launched (a command, a service, or the agent node of a
   * sub-agent), which does not exist yet when `tool_call_started` is sent, so a front end joins
   * the parent's card to the child's channel with it. It is the node's id in the tree, not the
   * task's counter id. Every event the loop sends carries it; it is optional only so that a
   * conversation stored before it existed still reads. A reader checks the id against the node
   * tree before acting on it.
   */
  describedCallSchema.extend({
    type: z.literal('task_running'),
    task: taskInfoSchema,
    nodeId: nodeIdSchema.exactOptional(),
    message: messageSchema,
    durationMs: z.number(),
  }),
  /** A background task finished (or failed); the model is told at the start of the next turn. */
  z.object({ type: z.literal('task_completed'), task: taskInfoSchema }),
  /**
   * A message sent to this session while it worked (user steering, or from the session that
   * started it), added to history before this turn's model call.
   */
  z.object({ type: z.literal('message_received'), message: inboxMessageSchema }),
  /**
   * Live and never kept in history. The run is `working` (the model or a tool runs) or `waiting`
   * (its turn is over and it is held open for tasks). `groupedTasks` is how many running tasks
   * grouped with `await_tasks` it still waits on, and 0 when `working`; `waiting` with 0 means
   * only ungrouped tasks or services remain, so the run is ready for a follow-up. Sent on every
   * change, so the newest one is the current state.
   */
  z.strictObject({
    type: z.literal('run_state'),
    state: z.enum(['working', 'waiting']),
    groupedTasks: z.number().int().nonnegative(),
  }),
  /** A hook's `beforeTurn` added this context to history; the model sees it from this turn on. */
  z.object({ type: z.literal('context_added'), hook: z.string(), content: z.string() }),
  /**
   * A hook's `beforeModelCall` changed the messages this model call sends. Counts only, for this
   * call: the stored history is unchanged. `added` and `removed` are messages the hook put in or
   * left out; `edited` are messages it kept but changed. Messages have no ids, so a tool result
   * (by call id) and an assistant message with tool calls (by its call ids) can be edited, while
   * a reworded user message or plain assistant message counts as one removed plus one added.
   * Reordering is not reported.
   */
  z.object({
    type: z.literal('model_input_changed'),
    hook: z.string(),
    turn: z.number().int().nonnegative(),
    added: z.number().int().nonnegative(),
    removed: z.number().int().nonnegative(),
    edited: z.number().int().nonnegative(),
  }),
  /**
   * A summary began. Always followed by exactly one `summary_done` or `summary_failed`, so a
   * "Summarizing…" indicator never hangs. Data only: a UI chooses what to show.
   */
  z.object({
    type: z.literal('summary_started'),
    reason: summaryReasonSchema,
    tokensBefore: z.number().int().nonnegative(),
    messagesBefore: z.number().int().nonnegative(),
  }),
  /**
   * A checkpoint was appended to history. Counts and a section index, not the text: a UI that
   * shows only "Summarized" needs nothing more, and one that shows the summary reads the
   * `summary` message from history (`sections` here say what it holds and how big each is).
   * `tokensAfter` is an estimate, not a measurement.
   */
  z.object({
    type: z.literal('summary_done'),
    tokensBefore: z.number().int().nonnegative(),
    tokensAfter: z.number().int().nonnegative(),
    messagesBefore: z.number().int().nonnegative(),
    messagesAfter: z.number().int().nonnegative(),
    /** Messages this checkpoint newly summarized, and how many stay word for word. */
    summarized: z.number().int().nonnegative(),
    kept: z.number().int().positive(),
    summarizer: z.string().min(1),
    sections: z.array(
      z.object({
        id: summarySectionIdSchema,
        title: z.string(),
        chars: z.number().int().nonnegative(),
      }),
    ),
  }),
  /** The summary did not happen and no checkpoint was appended; the run goes on unchanged. */
  z.object({
    type: z.literal('summary_failed'),
    reason: summaryReasonSchema,
    kind: summaryFailureKindSchema,
    /** Redacted like `run_failed`. */
    error: z.string(),
    /** Further tries this run before summaries stop being attempted. */
    retriesLeft: z.number().int().nonnegative(),
  }),
  /**
   * A hook handler failed where it must not stop the run (`onError`). The run's own error is
   * still what ends the stream; this says the hook couldn't do its job.
   */
  z.object({
    type: z.literal('hook_failed'),
    hook: z.string(),
    handler: z.string(),
    error: z.string(),
  }),
  /**
   * The conversation could not be stored (a stream, history or index write failed). Sent once when
   * storage starts failing, not per write, and never ends a run: the conversation refuses its
   * next prompt (`storage_failed`) unless a retry has stored what was lost. `error` is redacted
   * like `run_failed`. Live data for a UI; it is not model input.
   */
  z.object({ type: z.literal('storage_failed'), error: z.string() }),
  extensionEventSchema,
] as const;

/** The run's end, as the combined stream carries it: how it ended, without the history. */
const doneEntrySchema = z.object({
  type: z.literal('done'),
  reason: doneReasonSchema,
  session: sessionRefSchema,
});

/**
 * Always last. The full conversation (valid to continue from, even after an interrupt), for
 * whoever runs the loop. The combined stream drops `messages` (`entryEventSchema`).
 */
const doneEventSchema = doneEntrySchema.extend({ messages: z.array(historyMessageSchema) });

export const agentEventBodySchema = z.discriminatedUnion('type', [
  ...stepEventSchemas,
  doneEventSchema,
]);

/**
 * `seq`: 0, 1, 2, ... in the order consumers receive them. A run's events have no gaps; an event
 * that belongs to no run (`storage_failed`, `extension_event`) carries `seq` 0.
 */
const eventSeqSchema = z.object({ seq: z.number().int().nonnegative() });

/** Every event carries `seq` (`eventSeqSchema`). */
export const agentEventSchema = z.intersection(eventSeqSchema, agentEventBodySchema);

/**
 * An event as the combined stream (`StreamEntry`) carries it: the same, except that `done` has
 * no `messages`. The stream keeps every entry for replay, and a prompt's history in each one
 * would grow it with the square of the conversation; a UI reads the history on its own.
 */
const entryEventBodySchema = z.discriminatedUnion('type', [...stepEventSchemas, doneEntrySchema]);

export const entryEventSchema = z.intersection(eventSeqSchema, entryEventBodySchema);

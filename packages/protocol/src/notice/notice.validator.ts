import { z } from 'zod';
import { callIdSchema } from '../message/message.validator.js';
import { contextWindowSchema } from '../model/model.validator.js';
import { timestampSchema } from '../time/time.validator.js';
import { agentInfoSchema, runOutcomeSchema } from '../session/session.validator.js';
import { taskIdSchema, taskInfoSchema } from '../task/task.validator.js';
import { tokenUsageSchema } from '../usage/usage.validator.js';
import {
  extensionEnvelopeShape,
  extensionQualifiedNameSchema,
} from '../extension/extension.validator.js';
import { isInNamespace } from '../extension/extension.utils.js';
import {
  MAX_HOOK_FAILED_ERROR_CHARS,
  MAX_RUNNING_TASKS,
  MAX_RUNNING_TASK_TITLE_CHARS,
  MAX_RUNNING_TASK_REASON_CHARS,
} from './notice.constants.js';

/** A live task summary with no command or output; group is the first requested member's ID. */
export const runningTaskSchema = z.strictObject({
  id: taskIdSchema,
  title: z.string().max(MAX_RUNNING_TASK_TITLE_CHARS),
  reason: z.string().max(MAX_RUNNING_TASK_REASON_CHARS),
  startedAt: timestampSchema,
  group: taskIdSchema.exactOptional(),
});

/** A bounded snapshot, not a durable completion fact. */
export const runningTasksNoticeSchema = z
  .strictObject({
    kind: z.literal('running-tasks'),
    tasks: z.array(runningTaskSchema).min(1).max(MAX_RUNNING_TASKS),
    total: z.number().int().nonnegative(),
    omitted: z.number().int().nonnegative(),
  })
  .refine((notice) => notice.total === notice.tasks.length + notice.omitted, {
    message: 'total must equal tasks.length + omitted',
    path: ['total'],
  });

const contextStateSchema = z.union([
  z.object({
    window: contextWindowSchema,
    used: tokenUsageSchema.shape.inputTokens.optional(),
  }),
  z.object({
    window: z.never().optional(),
    used: tokenUsageSchema.shape.inputTokens,
  }),
]);

/**
 * Notices that belong to one model call: sent beside the history, never stored in it. Stale on the
 * next call (a context count) or already carried by history (a continuation's partial reply).
 */
const transientNoticeSchema = z.discriminatedUnion('kind', [
  runningTasksNoticeSchema,
  z.object({ kind: z.literal('context-usage'), context: contextStateSchema }),
  z.object({
    kind: z.literal('output-continuation'),
    attempt: z.number().int().positive(),
    maxAttempts: z.number().int().positive().optional(),
    /**
     * Why the reply stopped: `output_limit` (the default, when unset) or `connection`, a lost
     * connection to the provider. The model is told which, and a lost connection spends none of
     * the output limit's allowance.
     */
    reason: z.enum(['output_limit', 'connection']).optional(),
  }),
]);

/** Completion-time facts; the reason is agent-authored data, not model instructions. */
export const taskCompletionContextSchema = z.object({
  reason: z.string(),
  startedAt: timestampSchema,
  durationMs: z.number().nonnegative(),
  userMessagesSinceStart: z.number().int().nonnegative(),
  callId: callIdSchema.exactOptional(),
});

/**
 * Notices the model must remember, so they are stored in history as typed data and shown to the
 * model through the core formatter. A UI reads the same data from history and the event stream and
 * decides whether and how to render it. Each is a snapshot at the moment it was written: live
 * state still comes from the session stream, and a UI joins the two by id.
 */
const individualPersistentNoticeSchema = z.discriminatedUnion('kind', [
  /** A sub-agent finished: who it is and how it ended, and the complete report it wrote. */
  z.object({
    kind: z.literal('agent-report'),
    agent: agentInfoSchema,
    /**
     * The background task the parent started it as. Absent for a report written when a
     * conversation was reopened: task ids restart then, so none would name the original task.
     */
    taskId: taskIdSchema.exactOptional(),
    outcome: runOutcomeSchema,
    /** What the sub-agent reported, whole: its final answer and nothing else. */
    report: z.string(),
    context: taskCompletionContextSchema,
  }),
  /** A background task finished: its snapshot, whose `output` stays the bounded preview. */
  z.object({
    kind: z.literal('task-finished'),
    task: taskInfoSchema,
    context: taskCompletionContextSchema,
  }),
]);

/**
 * A hook handler failed and the run went on without its contribution. The error is redacted
 * hook output: data, not an instruction. `repeats` counts the later failures of the same hook
 * and handler that were folded into this notice instead of getting their own. Never nested in a
 * task delivery.
 */
const hookFailedNoticeSchema = z.object({
  kind: z.literal('hook-failed'),
  hook: z.string().min(1),
  handler: z.string().min(1),
  error: z.string().max(MAX_HOOK_FAILED_ERROR_CHARS),
  repeats: z.number().int().positive().exactOptional(),
});

/**
 * An extension's own notice, shown to the model through the core formatter. Only `text` reaches
 * the model, as third-party data that is not an instruction; `data` is for UIs. `topic` is
 * `<extension>.<name>` in the sender's namespace, and any topic parses. Exported so the
 * extension host can check an envelope with the schema history will read it with.
 */
export const extensionNoticeSchema = z
  .object({
    kind: z.literal('extension-notice'),
    ...extensionEnvelopeShape,
    topic: extensionQualifiedNameSchema,
  })
  .refine((notice) => isInNamespace({ extension: notice.extension, name: notice.topic }), {
    message: 'topic must start with "<extension>."',
    path: ['topic'],
  });

/** A completion delivery retains the agent-authored wait reason as data, not instructions. */
export const persistentNoticeSchema = z.union([
  individualPersistentNoticeSchema,
  hookFailedNoticeSchema,
  extensionNoticeSchema,
  z.object({
    kind: z.literal('tasks-finished'),
    reason: z.string(),
    notices: z.array(individualPersistentNoticeSchema).min(1),
    context: taskCompletionContextSchema,
  }),
]);

/**
 * How long a notice lives: `transient` is sent beside one model call and never stored,
 * `persistent` is also kept in history. The kind decides, in `NOTICE_LIFETIMES`.
 */
export const noticeLifetimeSchema = z.enum(['transient', 'persistent']);

/** Harness-originated data shared by the model and UI, without model instructions or UI styling. */
export const harnessNoticeSchema = z.union([transientNoticeSchema, persistentNoticeSchema]);

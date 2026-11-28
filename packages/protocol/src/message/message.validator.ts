import { z } from 'zod';
import { TURN_STOP_REASONS } from '../status/status.constants.js';
import { timestampSchema } from '../time/time.validator.js';
import { skillNameSchema } from '../skill/skill.validator.js';
import { lowercaseUuidSchema } from '../id/id.validator.js';

/** A persisted user message's stable identity, never sent to the model. Only a prompt a person typed has one. */
export const messageIdSchema = lowercaseUuidSchema.brand<'MessageId'>();

/**
 * A tool call's id, as the model's backend gave it. Branded, so it can't be passed where a
 * session's, task's or approval's id goes; it is still a plain string on the wire.
 */
export const callIdSchema = z.string().brand<'CallId'>();

/**
 * When a message was created. Optional on the wire because a caller writes messages by hand (a
 * client seeding history, a hook's context); the harness stamps every message it makes. Never
 * sent to a model.
 */
export const messageTimeSchema = timestampSchema.exactOptional();

/** A tool call the model asked for. */
export const toolCallSchema = z.object({
  id: callIdSchema,
  name: z.string(),
  /** Raw input from the model. Validated with zod before the tool runs. */
  input: z.unknown(),
});

/**
 * Opaque reasoning state from the model (e.g. Responses API encrypted reasoning).
 * Kept in history and resent so the model can continue its reasoning across tool calls.
 * Only the provider that produced it can read it, so it's tagged with `source`.
 */
export const reasoningItemSchema = z.object({
  /** Identifies the backend + model that produced the item. */
  source: z.string(),
  /** Provider-specific payload, resent verbatim. */
  data: z.unknown(),
});

/**
 * One part of what the user typed: text, or a skill they picked (a chip in a UI). A UI sends
 * parts so the harness runs exactly the skills picked, without reading `/<name>` out of text.
 */
export const promptPartSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('text'), text: z.string() }),
  z.object({ type: z.literal('skill'), name: skillNameSchema }),
]);

/** A summary section's id, stable across checkpoints so a UI can pick one out by it. */
export const summarySectionIdSchema = z.string().min(1).brand<'SummarySectionId'>();

/** One part of a summary: its id, a title, and its text. */
const summarySectionSchema = z.object({
  id: summarySectionIdSchema,
  title: z.string(),
  body: z.string(),
});

/** A tool's result as the model reads it: the call it answers, its text, and whether it failed. */
export const toolMessageSchema = z.object({
  role: z.literal('tool'),
  toolCallId: callIdSchema,
  content: z.string(),
  isError: z.boolean(),
  at: messageTimeSchema,
});

/**
 * What a model is sent: user, assistant and tool messages. A `summary` is not one of them: the
 * loop renders the latest checkpoint as text in the view, so a provider never has to know the
 * role (`historyMessageSchema`, in `history/`, adds it for whoever keeps the whole history).
 */
export const messageSchema = z.discriminatedUnion('role', [
  z.object({
    role: z.literal('user'),
    id: messageIdSchema.exactOptional(),
    /**
     * Set to `user` only by the host, on a prompt a person typed. Text a hook added, a sub-agent's
     * task or a message from another agent never has it, so a guard can tell what the user said
     * from what an agent wrote. An `id` does not say this: a sub-agent's task has one.
     */
    origin: z.literal('user').exactOptional(),
    /** What the model saw: the text, with the instructions of any skills it ran. */
    content: z.string(),
    /** What the user typed, when it ran skills: for a UI to show, never sent to the model. */
    parts: z.array(promptPartSchema).exactOptional(),
    at: messageTimeSchema,
  }),
  z.object({
    role: z.literal('assistant'),
    content: z.string(),
    toolCalls: z.array(toolCallSchema),
    reasoning: z.array(reasoningItemSchema).exactOptional(),
    at: messageTimeSchema,
  }),
  toolMessageSchema,
]);

/**
 * A checkpoint appended to history; what came before it is never rewritten. A model sees the
 * latest one in place of everything older than the `kept` messages right before it. Counts, not
 * indices, so a history repaired after a crash (placeholder results inserted) stays valid.
 */
export const summaryMessageSchema = z.object({
  role: z.literal('summary'),
  sections: z
    .array(summarySectionSchema)
    .refine((sections) => new Set(sections.map((section) => section.id)).size === sections.length, {
      message: 'section ids must be unique',
    }),
  /**
   * How many messages directly before this one are still shown word for word, counting every
   * entry (an earlier checkpoint included). At least one: the latest user message is always kept.
   */
  kept: z.number().int().positive(),
  /** How many messages this checkpoint newly summarized (the span since the previous one). */
  summarized: z.number().int().nonnegative(),
  /**
   * Where coverage ends: the entries before this position in history are incorporated (pinned
   * requests aside, which the view still shows). Equals this checkpoint's own position minus
   * `kept`, and never goes back past the previous checkpoint's.
   */
  covered: z.number().int().positive(),
  /**
   * The position of the earlier checkpoint this one folded in, so a summary is never taken from
   * scratch and none is skipped. Absent for the first checkpoint.
   */
  incorporated: z.number().int().nonnegative().exactOptional(),
  /** The name of what wrote it. */
  summarizer: z.string().min(1),
  at: messageTimeSchema,
});

/** Why a turn ended: the model's reason, or `interrupted` if the run's signal aborted. */
export const turnStopReasonSchema = z.enum(TURN_STOP_REASONS);

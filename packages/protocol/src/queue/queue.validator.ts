import { z } from 'zod';
import { messageIdSchema } from '../message/message.validator.js';
import { queuedPromptsSchema } from '../server/server.validator.js';

const queuedLinesSchema = queuedPromptsSchema.shape.queued;
/**
 * What the user typed: a prompt that starts at once may be longer than a queued line can be, and
 * one that picks only skills as parts may write as nothing. A follower must parse every one.
 */
const lineSchema = z.string();

/**
 * A line joined the queue, or a client replaced the lines. `dropped` holds the message ids of the
 * lines that left the queue because the client replaced them, neither started nor refused: it is
 * left out when none did.
 */
export const queueChangedSchema = z.object({
  type: z.literal('queue_changed'),
  queued: queuedLinesSchema,
  dropped: z.array(messageIdSchema).max(100).exactOptional(),
});

/**
 * `text` started as the conversation's next prompt: the entries of its run follow. `messageId` is
 * the id the line was accepted with, which the user message of that run has.
 */
export const promptStartedSchema = z.object({
  type: z.literal('prompt_started'),
  messageId: messageIdSchema,
  text: lineSchema,
  queued: queuedLinesSchema,
});

/**
 * `text` left the queue without starting, for the reason `error` gives; the next line goes on.
 * `messageId` is the id the line was accepted with, the one it would have started with.
 */
export const promptRefusedSchema = z.object({
  type: z.literal('prompt_refused'),
  messageId: messageIdSchema,
  text: lineSchema,
  error: z.string(),
  queued: queuedLinesSchema,
});

/**
 * A change to the lines waiting in a conversation's queue, in order with its runs on the combined
 * stream. Each carries the whole queue after the change, so the newest one says what waits. A line
 * has its message id from the moment the conversation accepts it, so a follower finds what became
 * of it by id: it started (`prompt_started`), was refused (`prompt_refused`) or was replaced away
 * (`dropped`).
 */
export const queueUpdateSchema = z.discriminatedUnion('type', [
  queueChangedSchema,
  promptStartedSchema,
  promptRefusedSchema,
]);

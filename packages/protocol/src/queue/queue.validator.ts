import { z } from 'zod';
import { queuedPromptsSchema } from '../server/server.validator.js';

const queuedLinesSchema = queuedPromptsSchema.shape.queued;
/**
 * What the user typed: a prompt that starts at once may be longer than a queued line can be, and
 * one that picks only skills as parts may write as nothing. A follower must parse every one.
 */
const lineSchema = z.string();

/**
 * A change to the lines waiting in a conversation's queue, in order with its runs on the combined
 * stream. Each carries the whole queue after the change, so the newest one says what waits.
 */
export const queueUpdateSchema = z.discriminatedUnion('type', [
  /** A line joined the queue, or a client replaced the lines. */
  z.object({ type: z.literal('queue_changed'), queued: queuedLinesSchema }),
  /** `text` started as the conversation's next prompt: the entries of its run follow. */
  z.object({ type: z.literal('prompt_started'), text: lineSchema, queued: queuedLinesSchema }),
  /** `text` left the queue without starting, for the reason `error` gives; the next line goes on. */
  z.object({
    type: z.literal('prompt_refused'),
    text: lineSchema,
    error: z.string(),
    queued: queuedLinesSchema,
  }),
]);

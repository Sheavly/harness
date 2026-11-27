import type { z } from 'zod';
import type {
  promptRefusedSchema,
  promptStartedSchema,
  queueChangedSchema,
  queueUpdateSchema,
} from './queue.validator.js';

/** A change to a conversation's queued lines: one joined, one started, one refused, or all replaced. */
export type QueueUpdate = z.infer<typeof queueUpdateSchema>;

/** A line joined the queue, or a client replaced the lines, dropping some by their ids. */
export type QueueChanged = z.infer<typeof queueChangedSchema>;

/** A queued line started, with the message id it was accepted with. */
export type PromptStarted = z.infer<typeof promptStartedSchema>;

/** A queued line left the queue without starting, with the message id it was accepted with. */
export type PromptRefused = z.infer<typeof promptRefusedSchema>;

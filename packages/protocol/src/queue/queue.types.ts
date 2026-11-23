import type { z } from 'zod';
import type { queueUpdateSchema } from './queue.validator.js';

/** A change to a conversation's queued lines: one joined, one started, one refused, or all replaced. */
export type QueueUpdate = z.infer<typeof queueUpdateSchema>;

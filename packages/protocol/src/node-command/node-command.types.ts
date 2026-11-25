import type { z } from 'zod';
import type { promptSentSchema } from './node-command.validator.js';

/**
 * The answer to a prompt sent: the agent node whose channel carries the run, whether the prompt
 * `started` (with the id of the user message it became) or waits in the queue (`queued`), and the
 * queue after it.
 */
export type PromptSent = z.infer<typeof promptSentSchema>;

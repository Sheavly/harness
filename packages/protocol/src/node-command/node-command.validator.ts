import { z } from 'zod';
import { messageIdSchema } from '../message/message.validator.js';
import { nodeIdSchema } from '../node/node.validator.js';
import { queuedPromptsSchema } from '../server/server.validator.js';
import { MAX_NODE_MESSAGE_CHARS } from './node-command.constants.js';

/**
 * `POST …/nodes/{node}/messages`: a message to an agent node, which sees it at its next model
 * call. The node is in the path, and who sent it is the caller, never a field: the user steering
 * the root agent and a parent steering a sub-agent are one command with a different sender.
 * Cancelling a node (`POST …/nodes/{node}/cancel`) has no body and is answered with nothing.
 */
export const messageNodeRequestSchema = z.object({
  text: z.string().min(1).max(MAX_NODE_MESSAGE_CHARS),
});

/**
 * `POST /conversations/:id/prompts`, answered at once with the ids of what it made: `node`, the
 * agent whose channel carries the run, and `messageId`, the user message the prompt is. A prompt
 * that `started` has that message now; one that waits in the queue (`queued`) has it from the
 * moment the conversation accepts the line, and the queue's `prompt_started` (or `prompt_refused`)
 * update and the run's entries name the same id when the line starts. `queued` is the queue after
 * this request. What the prompt does arrives on the channels, never in this answer.
 */
export const promptSentSchema = z.discriminatedUnion('status', [
  z.object({
    status: z.literal('started'),
    node: nodeIdSchema,
    messageId: messageIdSchema,
    queued: queuedPromptsSchema.shape.queued,
  }),
  z.object({
    status: z.literal('queued'),
    node: nodeIdSchema,
    messageId: messageIdSchema,
    queued: queuedPromptsSchema.shape.queued,
  }),
]);

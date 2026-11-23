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
 * agent whose channel carries the run, and, for a prompt that `started`, `messageId` of the user
 * message it became, which that run's entries name. A prompt that waits in the queue (`queued`)
 * has no message yet: it is a line of text until the conversation starts it, and the tree
 * channel's `prompt_started` entry names its message then. `queued` is the queue after this
 * request. What the prompt does arrives on the channels, never in this answer.
 *
 * The `queued` shape is strict on purpose: it refuses a `messageId`, which a queued prompt cannot
 * have, where an unknown field is otherwise dropped.
 */
export const promptSentSchema = z.discriminatedUnion('status', [
  z.object({
    status: z.literal('started'),
    node: nodeIdSchema,
    messageId: messageIdSchema,
    queued: queuedPromptsSchema.shape.queued,
  }),
  z.strictObject({
    status: z.literal('queued'),
    node: nodeIdSchema,
    queued: queuedPromptsSchema.shape.queued,
  }),
]);

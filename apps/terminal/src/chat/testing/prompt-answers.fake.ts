import { messageIdSchema } from '@sheavly/protocol/message/message.validator';
import type { PromptSent } from '@sheavly/protocol/node-command/node-command.types';
import { nodeIdSchema } from '@sheavly/protocol/node/node.validator';

const NODE = nodeIdSchema.parse('agent-1');

/**
 * Test-only: the message id every prompt of a fake backend is answered with and starts with
 * (`startedAnswer`, `queuedAnswer`, and the live feed's `promptStarted`): a client finds its run by
 * it.
 */
export const PROMPT_MESSAGE = messageIdSchema.parse('00000000-0000-4000-8000-0000000000cd');

/** Test-only: the answer to a prompt that started at once, with `queued` behind it. */
export const startedAnswer = (queued: string[] = []): PromptSent => ({
  status: 'started',
  node: NODE,
  messageId: PROMPT_MESSAGE,
  queued,
});

/** Test-only: the answer to a prompt that waits in the queue, which is `queued` after it. */
export const queuedAnswer = (queued: string[]): PromptSent => ({
  status: 'queued',
  node: NODE,
  messageId: PROMPT_MESSAGE,
  queued,
});

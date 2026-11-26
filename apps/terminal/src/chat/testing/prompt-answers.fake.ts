import { messageIdSchema } from '@sheavly/protocol/message/message.validator';
import type { PromptSent } from '@sheavly/protocol/node-command/node-command.types';
import { nodeIdSchema } from '@sheavly/protocol/node/node.validator';

const NODE = nodeIdSchema.parse('agent-1');
const MESSAGE = messageIdSchema.parse('00000000-0000-4000-8000-0000000000cd');

/** Test-only: the answer to a prompt that started at once, with `queued` behind it. */
export const startedAnswer = (queued: string[] = []): PromptSent => ({
  status: 'started',
  node: NODE,
  messageId: MESSAGE,
  queued,
});

/** Test-only: the answer to a prompt that waits in the queue, which is `queued` after it. */
export const queuedAnswer = (queued: string[]): PromptSent => ({
  status: 'queued',
  node: NODE,
  queued,
});

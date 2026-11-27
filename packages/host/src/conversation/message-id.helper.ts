import { randomUUID } from 'node:crypto';
import type { MessageId } from '@sheavly/protocol/message/message.types';
import { messageIdSchema } from '@sheavly/protocol/message/message.validator';

/**
 * A new id for a user message. A prompt gets its id when the conversation accepts it (a queued line
 * at once, a started prompt as it starts), so the host mints it there and hands it to the run.
 */
export function mintMessageId(): MessageId {
  return messageIdSchema.parse(randomUUID());
}

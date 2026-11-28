import { z } from 'zod';
import { itemSchema } from '../item/item.validator.js';
import { messageIdSchema } from '../message/message.validator.js';
import { nodeIdSchema } from '../node/node.validator.js';
import { entrySchema, isAfterOpened } from './cursor.validator.js';

/**
 * A completed item of an agent, as its channel stores it: one entry for each item, under the
 * channel's own cursor and with the originating user message (`messageId`) where there was one. A
 * channel that stores items holds them in place of the events they replace.
 */
export const nodeItemSchema = entrySchema
  .extend({
    channel: nodeIdSchema,
    type: z.literal('item'),
    item: itemSchema,
    messageId: messageIdSchema.exactOptional(),
  })
  .refine(({ cursor }) => isAfterOpened(cursor), {
    error: 'an item entry is numbered after the opened entry',
    path: ['cursor'],
  });

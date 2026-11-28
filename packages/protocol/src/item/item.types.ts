import type { z } from 'zod';
import type { itemEventSchema, itemIdSchema, itemSchema } from './item.validator.js';

/** An item's identity: a lowercase UUID minted when it starts, never a provider's. */
export type ItemId = z.infer<typeof itemIdSchema>;

/** One completed item of an agent's channel: a message, reasoning, or a tool call with its result. */
export type Item = z.infer<typeof itemSchema>;

/** What an item says as it happens: started, grown by a delta, or completed. */
export type ItemEvent = z.infer<typeof itemEventSchema>;

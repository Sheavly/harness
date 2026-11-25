import type { z } from 'zod';
import type { channelEntrySchema, channelNameSchema } from '../channel/channel.validator.js';
import type {
  channelEndFrameSchema,
  channelHeadFrameSchema,
  subscribeFrameSchema,
  subscribeRequestSchema,
} from './subscription.validator.js';

/** The name of a channel: a node's id, or `tree`. */
export type ChannelName = z.infer<typeof channelNameSchema>;

/** A subscribe request: the channels to follow, where to start in each, and the approvals claim. */
export type SubscribeRequest = z.infer<typeof subscribeRequestSchema>;

/** An entry of a node's channel as a subscription serves it: opened, an agent's updated, closed. */
export type ServedEntry = z.infer<typeof channelEntrySchema>;

/** Where a channel stood when a subscription at `now` opened. */
export type ChannelHeadFrame = z.infer<typeof channelHeadFrameSchema>;

/** One channel of a subscription ended, and why. */
export type ChannelEndFrame = z.infer<typeof channelEndFrameSchema>;

/** One frame of a subscribe stream: an entry, a head, or an end. */
export type SubscribeFrame = z.infer<typeof subscribeFrameSchema>;

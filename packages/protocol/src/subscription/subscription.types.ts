import type { z } from 'zod';
import type { channelEntrySchema, channelNameSchema } from '../channel/channel.validator.js';
import type { TreeChannelEntry, TreeSnapshot } from '../tree/tree.types.js';
import type { UsageChannelEntry, UsageSnapshot } from '../usage/usage.types.js';
import type {
  channelEndFrameSchema,
  channelHeadFrameSchema,
  liveFrameSchema,
  subscribeFrameSchema,
  subscribeRequestSchema,
} from './subscription.validator.js';

/** The name of a channel: a node's id, or the name of one of the conversation's own channels. */
export type ChannelName = z.infer<typeof channelNameSchema>;

/** A subscribe request: the channels to follow, where to start in each, and the approvals claim. */
export type SubscribeRequest = z.infer<typeof subscribeRequestSchema>;

/**
 * An entry as a subscription serves it: one of a node's channel (opened, an agent's updated,
 * closed) or of a channel of the conversation itself (the tree, usage).
 */
export type ServedEntry = z.infer<typeof channelEntrySchema> | TreeChannelEntry | UsageChannelEntry;

/**
 * The view a channel of the conversation itself starts a subscriber from (`from: snapshot`): the
 * channel's state as it stands, with the cursor it covers up to. The tree's, or usage's.
 */
export type ConversationSnapshot = TreeSnapshot | UsageSnapshot;

/** Where a channel stood when a subscription at `now` opened. */
export type ChannelHeadFrame = z.infer<typeof channelHeadFrameSchema>;

/** One channel of a subscription ended, and why. */
export type ChannelEndFrame = z.infer<typeof channelEndFrameSchema>;

/** What an item says as it happens, with no cursor: an item started, or a message's text grew. */
export type LiveFrame = z.infer<typeof liveFrameSchema>;

/** One frame of a subscribe stream: an entry, a head, an end, a snapshot, or a live frame. */
export type SubscribeFrame = z.infer<typeof subscribeFrameSchema>;

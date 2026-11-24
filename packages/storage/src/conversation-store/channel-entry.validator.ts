import { z } from 'zod';
import { channelLogSchema } from '@sheavly/protocol/channel/channel.validator';

/**
 * The marker a channel leaves next to its log when it refused an entry for a limit,
 * `channels/<channel>.full`: why, as a fixed phrase. Its presence is what makes the refusal last
 * across a restart, so a log that is missing an entry is never taken up again and read as whole.
 */
export const channelFullMarkerSchema = z.object({ reason: z.string().max(200) });

/**
 * One line of a channel's log file: what every entry has (the channel it belongs to, its cursor,
 * its type, when it was written), and whatever else its type holds, which the store keeps and does
 * not look into. It is the protocol's own entry, taken from the schema of a whole log
 * (`channelLogSchema.element`), so the file and the wire name one shape. A log is read a line at a
 * time, never as the whole array that schema checks.
 */
export const storedChannelEntrySchema = channelLogSchema.element;

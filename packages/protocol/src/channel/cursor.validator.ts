import { z } from 'zod';
import { timestampSchema } from '../time/time.validator.js';
import { BYTE_CURSOR_PATTERN, SEQUENCE_CURSOR_PATTERN } from './channel.constants.js';
import { cursorNumber } from './channel.utils.js';

/**
 * A position in a channel that numbers its entries: `s` and the position, 0, 1, 2, … with no gaps.
 * The tree channel and an agent's channel use it. Opaque to a client, which keeps the last one it
 * saw and sends it back.
 */
export const sequenceCursorSchema = z
  .string()
  .regex(SEQUENCE_CURSOR_PATTERN, 'must be s and a position');

/**
 * A position in the output of a command or a service: `b` and an offset in bytes. Opaque to a
 * client, which asks for "from here" and gets the bytes after it with no re-framing.
 */
export const byteCursorSchema = z
  .string()
  .regex(BYTE_CURSOR_PATTERN, 'must be b and a byte offset');

/** A cursor of either kind. Which kind a channel has is the channel's, and a client never builds one. */
export const cursorSchema = z.union([sequenceCursorSchema, byteCursorSchema]);

/** What every entry of every channel has: where it is and when it was written. */
export const entrySchema = z.object({ cursor: cursorSchema, at: timestampSchema });

/** Whether `cursor` numbers an entry after the first: what an agent's entries between its `opened` and `closed` have. */
export const isAfterOpened = (cursor: string) =>
  sequenceCursorSchema.safeParse(cursor).success && cursorNumber(cursor) >= 1;

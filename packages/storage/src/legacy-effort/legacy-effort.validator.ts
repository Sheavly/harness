import { z } from 'zod';
import { profileSchema } from '@sheavly/protocol/profile/profile.validator';
import { storedConversationSchema } from '@sheavly/protocol/store/store.validator';
import { streamEntrySchema } from '@sheavly/protocol/stream/stream.validator';
import {
  readLegacyConversationIndex,
  readLegacyProfile,
  readLegacyStreamEntry,
} from './legacy-effort.utils.js';

/** What `profile.json` holds, including the files written before "mode" became "effort". */
export const storedProfileFileSchema = z.preprocess(readLegacyProfile, profileSchema);

/** What a conversation's `index.json` holds, including the files written before "mode" became "effort". */
export const storedConversationIndexSchema = z.preprocess(
  readLegacyConversationIndex,
  storedConversationSchema,
);

/**
 * A line of a conversation's `stream.jsonl`, including the lines written before "mode" became
 * "effort" and the queue lines written before a queued line had a message id.
 */
export const storedStreamEntrySchema = z.preprocess(readLegacyStreamEntry, streamEntrySchema);

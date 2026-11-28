import type { StreamEntry } from '@sheavly/protocol/stream/stream.types';
import { storedStreamEntrySchema } from '../legacy-effort/legacy-effort.validator.js';

/**
 * The stream entry that `json` holds, or undefined when it is none: one line of a conversation's
 * `stream.jsonl`, or the data of one `entry` frame of a workbook run's `sessions.sse`, already
 * parsed. It reads the forms an older version wrote as well as today's (`mode` before it was
 * `effort`, and a queue line that started or was refused before a queued line had a message id), so
 * a reader of a stored stream outside this package reads it with this, never with the protocol's
 * `streamEntrySchema`, which is the wire's and refuses those lines. The forms themselves stay in
 * `legacy-effort/`, which is closed: this is the one way in.
 */
export function parseStoredStreamEntry(json: unknown): StreamEntry | undefined {
  const parsed = storedStreamEntrySchema.safeParse(json);

  return parsed.success ? parsed.data : undefined;
}

import { ENTRY_EVENT } from '@sheavly/protocol/api/api.constants';
import { streamEntrySchema } from '@sheavly/protocol/stream/stream.validator';
import type { StreamEntry } from '@sheavly/protocol/stream/stream.types';
import { readSseFrames } from './sse.helper.js';

/**
 * The entries of a backend's SSE answer (`QUERY /stream`), in order, each
 * parsed with the protocol's schema. Heartbeats, a head frame and other frames are skipped. Ends
 * when the body does. Each entry comes with its frame's SSE `id` as `cursor`: its position in the
 * stream, not an id of any kind. A client that stops early cancels it by breaking out of the loop.
 */
export async function* readEntries(body: ReadableStream<Uint8Array> | null): AsyncGenerator<{
  cursor: string;
  entry: StreamEntry;
}> {
  for await (const { cursor, entry } of readFrames(body)) {
    if (entry) yield { cursor, entry };
  }
}

/**
 * Every frame of an SSE answer that has an `id`: an entry's, and the head frame a live stream
 * opens with, which has no entry (`entry` is undefined) and whose `cursor` is the `seq` of the last
 * entry made before the stream opened. A client that has received nothing yet resumes after it, so
 * what is made while the stream is down is not missed. Heartbeats and other frames are skipped.
 */
export async function* readFrames(body: ReadableStream<Uint8Array> | null): AsyncGenerator<{
  cursor: string;
  entry: StreamEntry | undefined;
}> {
  for await (const { event, cursor, data } of readSseFrames({
    body,
    route: 'streamConversation',
  })) {
    if (cursor === undefined) continue;

    // A frame of an `id` and nothing else is a head frame.
    if (event === undefined && data === undefined) {
      yield { cursor, entry: undefined };
      continue;
    }

    if (event !== ENTRY_EVENT || data === undefined) continue;

    yield { cursor, entry: streamEntrySchema.parse(JSON.parse(data)) };
  }
}

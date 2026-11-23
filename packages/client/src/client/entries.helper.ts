import { ENTRY_EVENT } from '@sheavly/protocol/api/api.constants';
import { streamEntrySchema } from '@sheavly/protocol/stream/stream.validator';
import type { StreamEntry } from '@sheavly/protocol/stream/stream.types';

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
  if (!body) return;

  const decoder = new TextDecoder();
  let buffered = '';

  for await (const chunk of body) {
    // SSE allows CRLF line endings; one form keeps the frame splitting below simple.
    buffered += decoder.decode(chunk, { stream: true }).replace(/\r\n?/g, '\n');

    for (let end = buffered.indexOf('\n\n'); end !== -1; end = buffered.indexOf('\n\n')) {
      const frame = parseFrame(buffered.slice(0, end));

      buffered = buffered.slice(end + 2);
      if (frame) yield frame;
    }
  }
}

/**
 * One frame's cursor and entry: an entry frame, or a head frame (an `id` and nothing else, no
 * entry). Undefined for a heartbeat comment or another event's frame.
 */
function parseFrame(frame: string): { cursor: string; entry: StreamEntry | undefined } | undefined {
  const event = /^event: (.*)$/m.exec(frame)?.[1];
  const id = /^id: (.*)$/m.exec(frame)?.[1];
  const data = /^data: (.*)$/m.exec(frame)?.[1];

  if (id === undefined) return undefined;
  if (event === undefined && data === undefined) return { cursor: id, entry: undefined };
  if (event !== ENTRY_EVENT || data === undefined) return undefined;

  return { cursor: id, entry: streamEntrySchema.parse(JSON.parse(data)) };
}

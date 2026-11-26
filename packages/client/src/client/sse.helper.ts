import { AnswerTooLargeError } from '../errors/client.errors.js';
import type { SseFrame } from './client.types.js';
import { MAX_RECENT_PIECES } from './sse.constants.js';

/**
 * The value of the first `name: value` line of `frame`. Lines end at `\n` alone, never matched with
 * `.` or `$`: those also stop at U+2028 and U+2029, which JSON leaves unescaped in a string, and
 * would cut an entry's data short. The lines are walked with `indexOf` and not split into an array,
 * which for a frame of millions of short lines is an array of millions of strings.
 */
function fieldOf(params: { frame: string; name: string }): string | undefined {
  const { frame, name } = params;
  const prefix = `${name}: `;
  let start = 0;

  while (start <= frame.length) {
    const newline = frame.indexOf('\n', start);
    const end = newline === -1 ? frame.length : newline;

    if (frame.startsWith(prefix, start)) return frame.slice(start + prefix.length, end);

    start = end + 1;
  }

  return undefined;
}

/** One frame's fields. A frame that is only a comment (`: heartbeat`) has none, and is no frame. */
function parseSseFrame(frame: string): SseFrame | undefined {
  const parsed = {
    event: fieldOf({ frame, name: 'event' }),
    cursor: fieldOf({ frame, name: 'id' }),
    data: fieldOf({ frame, name: 'data' }),
  };

  return Object.values(parsed).every((field) => field === undefined) ? undefined : parsed;
}

/**
 * The frames of a server-sent event stream, in order, as their lines said. Ends when the body
 * does. With `maxFrameChars`, a frame that grows past it before it ends throws
 * `AnswerTooLargeError` (for `route`) and the body is cancelled, so what a server sends without
 * ever ending a frame is not held without limit. What is held is the frame being read, in pieces
 * joined a thousand at a time (`MAX_RECENT_PIECES`), so its size is about its characters and not a
 * multiple of them however the server cuts it into chunks. The bound is checked after each chunk, so
 * a frame may pass it by one chunk, whatever size the transport hands over. A client that stops
 * early cancels the body by breaking out of the loop.
 */
export async function* readSseFrames(params: {
  body: ReadableStream<Uint8Array> | null;
  route: string;
  maxFrameChars?: number;
}): AsyncGenerator<SseFrame> {
  const { body, route, maxFrameChars } = params;

  if (!body) return;

  const decoder = new TextDecoder();
  const pending: PendingFrame = { parts: [], recent: [], chars: 0, heldNewline: false };

  for await (const chunk of body) {
    // SSE allows CRLF line endings; one form keeps the frame splitting below simple.
    const text = decoder.decode(chunk, { stream: true }).replace(/\r\n?/g, '\n');

    for (const ended of endedFrames({ pending, text })) {
      const frame = parseSseFrame(ended);

      if (frame) yield frame;
    }

    if (maxFrameChars !== undefined && pending.chars > maxFrameChars) {
      throw new AnswerTooLargeError({ route, maxBytes: maxFrameChars });
    }
  }
}

/**
 * The frame being read: what has come of it, in pieces, and how many characters that is. A final
 * newline is held back (`heldNewline`, and counted) because the blank line that ends a frame may be
 * cut between two chunks.
 */
type PendingFrame = {
  /** The frame so far: pieces joined as they piled up, then `recent`. */
  parts: string[];
  /** The latest pieces, as they came, until there are `MAX_RECENT_PIECES` of them. */
  recent: string[];
  chars: number;
  heldNewline: boolean;
};

/**
 * Adds `text` to the frame being read and answers the text of each frame it ends, in order. Only the
 * new text is searched for a blank line, and the pieces of a frame are joined once, when it ends:
 * a frame of thousands of chunks (a tree snapshot) costs what it is, where appending to one string
 * and searching it again for each chunk copies and scans all of it every time.
 */
function endedFrames(params: { pending: PendingFrame; text: string }): string[] {
  const { pending } = params;
  const ended: string[] = [];
  let rest = params.text;

  while (rest !== '') {
    const joined = pending.heldNewline ? `\n${rest}` : rest;
    const at = joined.indexOf('\n\n');

    if (at === -1) {
      keep({ pending, joined });
      break;
    }

    ended.push(pending.parts.join('') + pending.recent.join('') + joined.slice(0, at));
    pending.parts = [];
    pending.recent = [];
    pending.chars = 0;
    pending.heldNewline = false;
    rest = joined.slice(at + 2);
  }

  return ended;
}

/** Keeps `joined`, which holds no blank line, as part of the frame, holding back a last newline. */
function keep(params: { pending: PendingFrame; joined: string }): void {
  const { pending, joined } = params;
  const endsWithNewline = joined.endsWith('\n');
  // A newline held from the last chunk starts `joined` and was counted then.
  const alreadyCounted = pending.heldNewline ? 1 : 0;

  pending.recent.push(endsWithNewline ? joined.slice(0, -1) : joined);
  pending.chars += joined.length - alreadyCounted;
  pending.heldNewline = endsWithNewline;
  joinRecentWhenMany(pending);
}

/** Joins the recent pieces into one once there are `MAX_RECENT_PIECES` of them. */
function joinRecentWhenMany(pending: PendingFrame): void {
  if (pending.recent.length < MAX_RECENT_PIECES) return;

  pending.parts.push(pending.recent.join(''));
  pending.recent = [];
}

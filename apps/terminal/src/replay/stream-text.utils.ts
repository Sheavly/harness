import type { StreamEntry } from '@sheavly/protocol/stream/stream.types';
import { parseStoredStreamEntry } from '@sheavly/storage/conversation-store/stored-stream.utils';
import type { StoredStream, StreamSource } from './replay.types.js';

type Parsed = Pick<StoredStream, 'entries' | 'truncatedLastLine' | 'invalidLines'>;

/**
 * The entries in the text of a stored stream: a conversation's `stream.jsonl` (`conversation`, a
 * line each) or a run's `sessions.sse` (`run`, an `entry` frame each). It never throws: what is
 * not an entry is counted in `invalidLines` by its 1-based position, never quoted, because a
 * stored conversation is private. A last line or frame with no terminator after it is a write
 * cut off, as a crash leaves it: it is reported in `truncatedLastLine` and not read, as the
 * conversation store itself does.
 */
export function parseStreamText(params: { text: string; source: StreamSource }): Parsed {
  const { text, source } = params;

  return source === 'conversation' ? parseLines(text) : parseFrames(text);
}

/**
 * `text` as an entry, or undefined when it is not JSON or not an entry. A line an older version
 * wrote is read as today's entry (the storage package's reader), so replaying an old conversation
 * does not drop what it holds as "not an entry".
 */
function entryOf(text: string): StreamEntry | undefined {
  let json: unknown;

  try {
    json = JSON.parse(text);
  } catch (caughtError) {
    // Bad JSON is the finding, not a failure: it is counted, and its text (private) never quoted.
    if (!(caughtError instanceof SyntaxError)) throw caughtError;

    return undefined;
  }

  return parseStoredStreamEntry(json);
}

/** Reads `pieces` (already split at their terminators) with `read`, and files what is wrong. */
function collect(params: {
  pieces: string[];
  truncated: boolean;
  read: (piece: string) => StreamEntry | undefined | 'skip';
}): Parsed {
  const entries: StreamEntry[] = [];
  const invalidLines: number[] = [];

  params.pieces.forEach((piece, index) => {
    const result = params.read(piece);

    if (result === 'skip') return;
    if (result === undefined) invalidLines.push(index + 1);
    else entries.push(result);
  });

  return { entries, truncatedLastLine: params.truncated, invalidLines };
}

function parseLines(text: string): Parsed {
  const pieces = text.split('\n');
  const last = pieces.pop() ?? '';

  return collect({
    pieces,
    truncated: last.trim() !== '',
    read: (line) => (line.trim() === '' ? 'skip' : entryOf(line)),
  });
}

function parseFrames(text: string): Parsed {
  const pieces = text.replaceAll(/\r\n?/g, '\n').split('\n\n');
  const last = pieces.pop() ?? '';

  return collect({ pieces, truncated: last.trim() !== '', read: entryOfFrame });
}

/**
 * The entry a server-sent event frame carries. A comment (a heartbeat), the head frame with an id
 * and nothing else, and any event that is not an `entry` are not entries and are skipped.
 */
function entryOfFrame(frame: string): StreamEntry | undefined | 'skip' {
  const lines = frame.split('\n');
  const field = (name: string) =>
    lines.filter((line) => line.startsWith(`${name}:`)).map((line) => line.slice(name.length + 1));
  const data = field('data');

  if (data.length === 0 || field('event')[0]?.trim() !== 'entry') return 'skip';

  return entryOf(data.map((line) => line.replace(/^ /, '')).join('\n'));
}

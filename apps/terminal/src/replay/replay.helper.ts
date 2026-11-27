import type { SessionId } from '@sheavly/protocol/session/session.types';
import { Renderer } from '../render/render.service.js';
import type { Write } from '../render/render.types.js';
import type { ReplayOptions, StoredStream } from './replay.types.js';
import { readStoredStream } from './stored-stream.helper.js';
import { describeSummary } from './summary-text.utils.js';
import { summarizeStream } from './summary.utils.js';

/**
 * Writes what a stored stream holds: the rendered log, the way the live run printed it, or with
 * `json` one entry per line (each in today's form: a line an older version wrote is read as the
 * entry it is now, so `mode` is `effort` and a queue line with no message id has a placeholder one,
 * which the file does not hold), or with `summary` what the stream says about itself. `from` and
 * `session` narrow the entries; the summary always covers the whole stream, so a gap before
 * `from` is still found. Reads nothing but the stream and makes no network or model call.
 */
export async function replayStored(params: {
  options: ReplayOptions;
  write: Write;
  folder: string;
}): Promise<void> {
  const { options, write } = params;
  const stream = await readStoredStream(params.folder);

  if (options.summary) {
    const summary = summarizeStream(stream);

    write(options.json ? `${JSON.stringify(summary, null, 2)}\n` : describeSummary(summary));

    return;
  }

  const shown = pickEntries({ stream, options });

  if (options.json) {
    for (const entry of shown) write(`${JSON.stringify(entry)}\n`);

    return;
  }

  // The main session is the stream's first entry's, however the entries shown were narrowed:
  // from a later seq, the first entry left may belong to a sub-agent.
  const main = options.session ?? stream.entries[0]?.sessionId;

  if (main === undefined || shown.length === 0) {
    write('No entries to replay.\n');

    return;
  }

  renderEntries({ entries: shown, main, write });
}

/** The entries from `options.from` on, of `options.session` when one is named. */
function pickEntries(params: { stream: StoredStream; options: ReplayOptions }) {
  const { stream, options } = params;

  return stream.entries.filter(
    (entry) =>
      entry.seq >= options.from &&
      (options.session === undefined || entry.sessionId === options.session),
  );
}

/**
 * Feeds the entries to the same `Renderer` the demo prints with. A stream that ends with tools
 * still running (no `done`) says so, since the renderer would otherwise leave them unmentioned.
 */
function renderEntries(params: {
  entries: ReturnType<typeof pickEntries>;
  main: SessionId;
  write: Write;
}): void {
  const { entries, main, write } = params;
  const renderer = new Renderer(write);

  for (const entry of entries) renderer.entry(entry, main);

  if (renderer.running.length > 0) {
    write(
      `\n… the stream ends with ${String(renderer.running.length)} tool call(s) still running\n`,
    );
  }
}

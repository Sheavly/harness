import { StoreError } from '@sheavly/core/errors/store.errors';
import type { ChannelEntry } from '@sheavly/core/store/store.types';
import { cursorKind, cursorNumber } from '@sheavly/protocol/channel/channel.utils';
import { ChannelIndexError } from '../errors/storage.errors.js';
import { readJsonLines, readJsonLinesAt } from '../jsonl-file/jsonl-file.helper.js';
import { storedChannelEntrySchema } from './channel-entry.validator.js';
import type { ChannelSeen } from './channel-file.types.js';

/**
 * The entries of a channel's file from line `index` (0 is the first) to the end of what `seen` says
 * it held, reading from the start of the block of `every` lines that holds `index`, not from the
 * first line of the file: at most `every` lines are read that are not given. Nothing when `index` is
 * past the last line.
 *
 * A numbered channel's line `n` has the cursor `s<n>`, so each line up to and including the first
 * one given is checked to: an index whose offsets are wrong (a place that hides lines, or the middle
 * of one) shows there, before anything is given, as a `ChannelIndexError`. The lines after are not
 * checked, so a read stays as long as what it gives.
 */
export async function* linesFrom(params: {
  file: string;
  seen: ChannelSeen;
  every: number;
  index: number;
}): AsyncGenerator<ChannelEntry> {
  const { file, seen, every, index } = params;

  if (index >= seen.count) return;

  const block = Math.floor(index / every);
  const start = seen.offsets[block];

  if (start === undefined) throw new ChannelIndexError({ file, line: index });

  let line = block * every;

  for await (const { value } of readJsonLinesAt({
    file,
    schema: storedChannelEntrySchema,
    start,
    firstLine: line + 1,
  })) {
    if (line >= seen.count) return;

    if (line <= index && seen.kind === 'sequence' && value.cursor !== `s${String(line)}`) {
      throw new ChannelIndexError({ file, line });
    }

    if (line >= index) yield value;

    line += 1;
  }
}

/** The refusal for a cursor the channel does not hold. */
function cursorAbsent(params: { channel: string; cursor: string }): StoreError {
  return new StoreError({
    reason: 'cursor_out_of_range',
    message: `Cursor ${params.cursor} is not one of channel ${params.channel}'s entries`,
  });
}

/** The entries after the one with `cursor`, found by reading from the first line. */
async function* entriesAfterByReading(params: {
  file: string;
  channel: string;
  cursor: string;
}): AsyncGenerator<ChannelEntry> {
  const { file, channel, cursor } = params;
  let found = false;

  for await (const each of readJsonLines({ file, schema: storedChannelEntrySchema })) {
    if (found) yield each;

    found ||= each.cursor === cursor;
  }

  if (!found) throw cursorAbsent({ channel, cursor });
}

/**
 * The entries after the one with `cursor`, which a numbered channel finds by its number (its cursor
 * is its line's number, with no gap) and checks is the cursor of the line it reached; a byte
 * channel's cursor is not a line, so its few lines are read until it. `cursor_out_of_range` for a
 * cursor the channel does not hold, of the other kind, or past its last entry.
 */
export async function* entriesAfter(params: {
  file: string;
  channel: string;
  seen: ChannelSeen;
  every: number;
  cursor: string;
}): AsyncGenerator<ChannelEntry> {
  const { file, channel, seen, every, cursor } = params;
  const absent = () => cursorAbsent({ channel, cursor });

  if (seen.kind === 'byte') {
    yield* entriesAfterByReading({ file, channel, cursor });

    return;
  }

  const position = cursorKind(cursor) === 'sequence' ? cursorNumber(cursor) : -1;

  if (seen.kind === undefined || position < 0 || position >= seen.count) throw absent();

  let found = false;

  for await (const entry of linesFrom({ file, seen, every, index: position })) {
    if (found) {
      yield entry;
      continue;
    }

    if (entry.cursor !== cursor) throw absent();

    found = true;
  }

  if (!found) throw absent();
}

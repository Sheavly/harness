import { stat } from 'node:fs/promises';
import { StoreError } from '@sheavly/core/errors/store.errors';
import { channelAppendProblem } from '@sheavly/core/store/store.utils';
import { cursorKind, cursorNumber } from '@sheavly/protocol/channel/channel.utils';
import { isMissingPath } from '@sheavly/runtime/errors/errors.utils';
import { StorageFileError } from '../errors/storage.errors.js';
import { readJsonFile, writeJsonFile } from '../json-file/json-file.helper.js';
import { readJsonLinesAt } from '../jsonl-file/jsonl-file.helper.js';
import { storedChannelEntrySchema } from './channel-entry.validator.js';
import type { ChannelIndex, ChannelScan } from './channel-file.types.js';
import { channelIndexSchema } from './channel-index.validator.js';
import { MAX_CHANNEL_INDEX_BYTES } from './conversation-store.constants.js';

/**
 * The index `file` holds for the log `logFile` of `size` bytes, if it is one this log still agrees
 * with, and `undefined` otherwise, whatever the reason: no index, one that is too big, not valid,
 * made for other blocks or for a byte channel (only a numbered channel is long enough to need one),
 * covering more than the log holds, or whose last line is not the line the log has there (another
 * channel's index is not: its last line is that channel's). An index is a cache, so one that does
 * not fit is the same as none and is never an error.
 *
 * What it checks is that the log still has, at the place the index says it ends, the entry and the
 * bytes the index says it had. It does not read the lines before: they were checked when the index
 * was made. A read that begins at a place the index gave checks the lines it passes
 * (`linesFrom`), so an index that is wrong there is found, and the places it gave are replaced by
 * what a read of the whole log finds (`ChannelFile`).
 */
export async function readIndex(params: {
  file: string;
  logFile: string;
  every: number;
  size: number;
}): Promise<ChannelIndex | undefined> {
  const { file, logFile, every, size } = params;
  const index = await storedIndex(file);

  if (index === undefined) return undefined;

  if (index.every !== every || index.size > size || !isConsistent(index)) return undefined;

  return (await lastLineAgrees({ index, logFile })) ? index : undefined;
}

/** The index in `file`, or none when there is none, it is too big or it is not valid. */
async function storedIndex(file: string): Promise<ChannelIndex | undefined> {
  try {
    const info = await stat(file);

    // A regular file only: a link to a device or a pipe has no size to bound, and is not one the
    // store wrote.
    if (!info.isFile() || info.size > MAX_CHANNEL_INDEX_BYTES) return undefined;

    return await readJsonFile({ file, schema: channelIndexSchema, holdsSecrets: false });
  } catch (caughtError) {
    // A file that is not there, or not an index, is no index; anything else is not ours to hide.
    if (caughtError instanceof StorageFileError || isMissingPath(caughtError)) return undefined;

    throw caughtError;
  }
}

/**
 * Whether the index is of a numbered channel whose last cursor is one less than the lines it holds:
 * an index that says other is wrong.
 */
function isConsistent(index: ChannelIndex): boolean {
  return (
    cursorKind(index.last.cursor) === 'sequence' &&
    cursorNumber(index.last.cursor) === index.count - 1
  );
}

/** Whether the log has the line the index says it ends with, as long as the index says it was. */
async function lastLineAgrees(params: { index: ChannelIndex; logFile: string }): Promise<boolean> {
  const { index, logFile } = params;

  try {
    for await (const { value } of readJsonLinesAt({
      file: logFile,
      schema: storedChannelEntrySchema,
      start: index.lastOffset,
      firstLine: index.count,
    })) {
      const bytes = Buffer.byteLength(JSON.stringify(value)) + 1;

      return (
        value.channel === index.last.channel &&
        value.cursor === index.last.cursor &&
        value.type === index.last.type &&
        index.lastOffset + bytes === index.size
      );
    }
  } catch (caughtError) {
    // A place that is not the start of a line does not parse: the index does not agree with the log.
    if (caughtError instanceof StorageFileError) return false;

    throw caughtError;
  }

  return false;
}

/** Writes `index` to `file`, whole or not at all (`writeJsonFile`). Throws a `StorageFileError`. */
export async function writeIndex(params: { file: string; index: ChannelIndex }): Promise<void> {
  await writeJsonFile({ file: params.file, value: params.index });
}

/**
 * Whether `error`, from reading a log, says the log itself is damaged: a line that is not well
 * formed (`scanChannel`'s `StoreError`), or that is not JSON, not an entry or too long (a
 * `StorageFileError` with no cause: the helper made it from the text). A read of the disk that failed
 * (a `StorageFileError` with the system's error as its cause) is not: the disk may read next time.
 */
export function isLogDamage(error: unknown): boolean {
  return (
    error instanceof StoreError || (error instanceof StorageFileError && error.cause === undefined)
  );
}

/**
 * Reads the lines of the log `file` of channel `channel` after the ones `from` covers (all of them
 * with none), holding each to the rule an append is, so a file edited by hand into a log with a gap,
 * a repeat or another channel's entry is refused as the other logs refuse a gap. Throws a
 * `StoreError` naming the file, never what it holds.
 */
export async function scanChannel(params: {
  file: string;
  channel: string;
  every: number;
  from: ChannelIndex | undefined;
}): Promise<ChannelScan> {
  const { file, channel, every, from } = params;
  const found: ChannelScan = {
    count: from?.count ?? 0,
    offsets: from ? [...from.offsets] : [],
    last: from?.last,
    lastOffset: from?.lastOffset ?? 0,
    scanned: 0,
  };

  for await (const { value: each, offset } of readJsonLinesAt({
    file,
    schema: storedChannelEntrySchema,
    start: from?.size ?? 0,
    firstLine: (from?.count ?? 0) + 1,
  })) {
    const problem =
      each.channel === channel
        ? channelAppendProblem({ entry: each, last: found.last })
        : `a line of channel ${each.channel}`;

    if (problem !== undefined) {
      throw new StoreError({
        reason: 'failed',
        message: `Channel log ${file} is not well formed: ${problem}`,
      });
    }

    if (found.count % every === 0) found.offsets.push(offset);

    found.count += 1;
    found.scanned += 1;
    found.lastOffset = offset;
    found.last = { channel: each.channel, cursor: each.cursor, type: each.type };
  }

  return found;
}

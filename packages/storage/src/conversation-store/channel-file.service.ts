import { stat } from 'node:fs/promises';
import { StoreError } from '@sheavly/core/errors/store.errors';
import type {
  ChannelEntry,
  ChannelFrom,
  ChannelLog,
  ChannelSummary,
} from '@sheavly/core/store/store.types';
import {
  channelAppendEntry,
  channelAppendProblem,
  channelFromProblem,
} from '@sheavly/core/store/store.utils';
import type { ChannelHead } from '@sheavly/protocol/channel/channel.types';
import { cursorKind } from '@sheavly/protocol/channel/channel.utils';
import { isMissingPath } from '@sheavly/runtime/errors/errors.utils';
import { StorageFileError } from '../errors/storage.errors.js';
import { readJsonFile, writeJsonFile } from '../json-file/json-file.helper.js';
import {
  appendJsonLine,
  readJsonLines,
  readJsonLinesAt,
  trimPartialLine,
} from '../jsonl-file/jsonl-file.helper.js';
import { SerialQueue } from '../serial-queue/serial-queue.service.js';
import { channelFullMarkerSchema, storedChannelEntrySchema } from './channel-entry.validator.js';
import type { ChannelSeen } from './channel-file.types.js';
import type { ChannelQuota } from './channel-quota.service.js';
import { entriesAfter, linesFrom } from './channel-seek.helper.js';
import { CHANNEL_INDEX_EVERY } from './conversation-store.constants.js';
import { asStoreError } from './conversation-store.utils.js';

/**
 * One channel's log file, `channels/<channel>.jsonl`: an entry a line, in the order they were
 * written, each with the channel's own cursor, never rewritten. What may be appended, what may
 * come next and the entry that is kept (the entry's JSON, parsed again, so what is checked is what
 * is written) is `channelAppendEntry`'s, as in every store; the last entry is read from the file
 * once (checked as it is read, after a line cut off by a crash is trimmed) and then kept, and
 * appends go one at a time through a queue, so what is kept is the file's. One process owns a
 * conversation's channels: two writing one file would each count on their own and both think they
 * were next.
 *
 * A limit is the conversation's `ChannelQuota`. An entry past one is refused with `quota`, after
 * the files are counted again, since a write that failed in another channel may still be held. A
 * channel that already holds entries then refuses every later one, for good: it leaves a marker
 * beside its log (`<channel>.full`), which a later process reads, so a writer cannot leave a log
 * that is missing an entry and go on (a byte offset may jump, so nothing else would stop it). Until
 * the marker is written, each append tries again, and fails if it cannot, so no entry is stored
 * while this process lives; if the disk never lets it be written and the process ends, the next
 * finds no marker. A channel with no entries has none missing: it only refuses that entry, and
 * leaves no marker, so refused names cannot pile up files. To take a channel up again, raise its
 * limits, delete `<channel>.full` and restart: a running process keeps its refusal. A write that
 * fails makes the channel read its file again, which also sets what the quota holds for it to what
 * is really on disk.
 *
 * What it counts as it reads the file once (how many lines it holds, and where every
 * `CHANNEL_INDEX_EVERY`th starts) is kept and updated by each append, so `head` answers without
 * reading, and a read from a cursor or a tail begins at the block of lines that holds the one it
 * wants, not at the first line of a file that may hold weeks of a conversation. A numbered
 * channel's cursor is its line's number, so a cursor is found by its number; a byte channel's is
 * not, and it is searched for by reading (its log holds a few lines: the output is not in it).
 */
export class ChannelFile implements ChannelLog {
  readonly #file: string;
  readonly #markerFile: string;
  readonly #channel: string;
  readonly #quota: ChannelQuota;
  readonly #every: number;
  readonly #queue = new SerialQueue();
  #last: ChannelHead | undefined;
  #loaded = false;
  /** How many lines the file holds, and how many bytes they are, as far as this process knows. */
  #count = 0;
  #size = 0;
  /** `#offsets[n]` is where line `n * #every` starts. Only ever added to, until the file is read again. */
  #offsets: number[] = [];
  /** Why this channel takes no more entries, once it has refused one for a limit. */
  #refusedFor: string | undefined;
  /** Whether `<channel>.full` is on disk. */
  #marked = false;

  /** `indexEvery` is for a test that wants the blocks small; a store takes `CHANNEL_INDEX_EVERY`. */
  constructor(params: {
    file: string;
    markerFile: string;
    channel: string;
    quota: ChannelQuota;
    indexEvery?: number;
  }) {
    this.#file = params.file;
    this.#markerFile = params.markerFile;
    this.#channel = params.channel;
    this.#quota = params.quota;
    this.#every = params.indexEvery ?? CHANNEL_INDEX_EVERY;
  }

  async append(entry: ChannelEntry): Promise<void> {
    try {
      await this.#queue.run(async () => this.#appendOne(entry));
    } catch (caughtError) {
      throw asStoreError(caughtError);
    }
  }

  async head(): Promise<ChannelSummary> {
    try {
      // After the appends already queued, so what it says includes them. The file is read here only
      // the first time anything asks of it in this process.
      return await this.#queue.run(async () => {
        await this.#load();

        return { count: this.#count, newest: this.#last };
      });
    } catch (caughtError) {
      throw asStoreError(caughtError);
    }
  }

  async *read(from: ChannelFrom = 'start'): AsyncGenerator<ChannelEntry> {
    const problem = channelFromProblem(from);

    if (problem !== undefined) {
      throw new StoreError({ reason: 'cursor_out_of_range', message: problem });
    }

    try {
      yield* this.#entriesFrom(from);
    } catch (caughtError) {
      throw asStoreError(caughtError);
    }
  }

  /** Forgets what was kept, once the folder is deleted, so a channel made again starts from nothing. */
  async forget(): Promise<void> {
    await this.#queue.run(async () => {
      this.#last = undefined;
      this.#loaded = false;
      this.#count = 0;
      this.#size = 0;
      this.#offsets = [];
      this.#refusedFor = undefined;
      this.#marked = false;
    });
  }

  async #appendOne(entry: ChannelEntry): Promise<void> {
    await this.#load();

    const checked = channelAppendEntry({ entry, channel: this.#channel, last: this.#last });

    if ('error' in checked) throw checked.error;

    // From here on it is the checked copy that is sized, written and remembered, never the caller's.
    const kept = checked.entry;

    await this.#reserve(kept);

    try {
      await appendJsonLine({ file: this.#file, value: kept });
    } catch (caughtError) {
      // The line may or may not have landed: read the file again next time, which also sets the
      // quota to what the file really holds.
      this.#loaded = false;
      throw caughtError;
    }

    // The line `appendJsonLine` wrote is the JSON and a newline: it starts where the file ended.
    if (this.#count % this.#every === 0) this.#offsets.push(this.#size);

    this.#size += Buffer.byteLength(JSON.stringify(kept)) + 1;
    this.#count += 1;
    this.#last = { channel: kept.channel, cursor: kept.cursor, type: kept.type };
  }

  /** Holds the room `entry` needs, or refuses it with `quota` and makes the refusal last. */
  async #reserve(entry: ChannelEntry): Promise<void> {
    if (this.#refusedFor === undefined) {
      const size = Buffer.byteLength(JSON.stringify(entry)) + 1;
      let over = this.#quota.reserve({ channel: this.#channel, size });

      if (over === undefined) return;

      // Nothing is missing from a channel with no entries, so it refuses this one and no more.
      if (this.#last === undefined) throw this.#refusal(over);

      // A refusal here is for good, so it is made on what the files hold: a write that failed in
      // another channel, which has not appended since, may still be counted.
      await this.#quota.recount();
      over = this.#quota.reserve({ channel: this.#channel, size });

      if (over === undefined) return;

      this.#refusedFor = over;
    }

    // Every append after a refusal gets here, so a marker that could not be written is tried
    // again, and is a failure for as long as it cannot be: no entry is stored in the meantime that
    // the next process, finding no marker, would take for the next one.
    if (!this.#marked) {
      await writeJsonFile({ file: this.#markerFile, value: { reason: `it ${this.#refusedFor}` } });
      this.#marked = true;
    }

    throw this.#refusal(this.#refusedFor);
  }

  /** The bytes the channel's file has, `0` when there is none. */
  async #bytesOnDisk(): Promise<number> {
    try {
      return (await stat(this.#file)).size;
    } catch (caughtError) {
      if (isMissingPath(caughtError)) return 0;
      throw new StorageFileError({ file: this.#file, cause: caughtError });
    }
  }

  #refusal(why: string): StoreError {
    return new StoreError({
      reason: 'quota',
      message: `Channel ${this.#channel} ${why}, so it takes no more entries`,
    });
  }

  /**
   * Counts the quota, trims a cut-off line, finds the last entry and whether the channel is full,
   * once. Every line is held to the rule an append is, so a file edited by hand into a log with a
   * gap, a repeat or another channel's entry is refused here, as the other logs refuse a gap.
   */
  async #load(): Promise<void> {
    if (this.#loaded) return;

    // First, since it is cheap and a marker that cannot be read fails the load before the log is
    // scanned, which can be 128 MiB.
    const marker = await readJsonFile({
      file: this.#markerFile,
      schema: channelFullMarkerSchema,
      holdsSecrets: false,
    });

    await this.#quota.ready();
    await trimPartialLine({ file: this.#file });

    const size = await this.#bytesOnDisk();

    this.#quota.settle({ channel: this.#channel, size });

    let last: ChannelHead | undefined;
    let count = 0;
    const offsets: number[] = [];

    for await (const { value: each, offset } of readJsonLinesAt({
      file: this.#file,
      schema: storedChannelEntrySchema,
    })) {
      const problem =
        each.channel === this.#channel
          ? channelAppendProblem({ entry: each, last })
          : `a line of channel ${each.channel}`;

      if (problem !== undefined) {
        throw new StoreError({
          reason: 'failed',
          message: `Channel log ${this.#file} is not well formed: ${problem}`,
        });
      }

      if (count % this.#every === 0) offsets.push(offset);

      count += 1;
      last = { channel: each.channel, cursor: each.cursor, type: each.type };
    }

    if (marker !== undefined) {
      this.#refusedFor ??= 'is full';
      this.#marked = true;
    }

    this.#last = last;
    this.#count = count;
    this.#size = size;
    this.#offsets = offsets;
    this.#loaded = true;
  }

  /** What a read begins from: the file as this process knows it now. Call it after `#load`. */
  #seen(): ChannelSeen {
    return {
      count: this.#count,
      offsets: this.#offsets,
      kind: this.#last && cursorKind(this.#last.cursor),
    };
  }

  async *#entriesFrom(from: ChannelFrom): AsyncGenerator<ChannelEntry> {
    if (from === 'start') {
      yield* readJsonLines({ file: this.#file, schema: storedChannelEntrySchema });

      return;
    }

    // The file is read whole once in this process (by `#load`), after the appends already queued;
    // a read then begins at the block of lines that holds what it wants.
    const seen = await this.#queue.run(async () => {
      await this.#load();

      return this.#seen();
    });
    const every = this.#every;

    if ('tail' in from) {
      yield* linesFrom({
        file: this.#file,
        seen,
        every,
        index: Math.max(0, seen.count - from.tail),
      });

      return;
    }

    yield* entriesAfter({
      file: this.#file,
      channel: this.#channel,
      seen,
      every,
      cursor: from.after,
    });
  }
}

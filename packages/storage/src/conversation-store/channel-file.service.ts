import { stat } from 'node:fs/promises';
import { StoreError } from '@sheavly/core/errors/store.errors';
import type {
  ChannelEntry,
  ChannelFrom,
  ChannelLog,
  ChannelSummary,
} from '@sheavly/core/store/store.types';
import { channelAppendEntry, channelFromProblem } from '@sheavly/core/store/store.utils';
import type { ChannelHead } from '@sheavly/protocol/channel/channel.types';
import { cursorKind } from '@sheavly/protocol/channel/channel.utils';
import { isMissingPath } from '@sheavly/runtime/errors/errors.utils';
import { ChannelIndexError, StorageFileError } from '../errors/storage.errors.js';
import { readJsonFile, writeJsonFile } from '../json-file/json-file.helper.js';
import { appendJsonLine, readJsonLines, trimPartialLine } from '../jsonl-file/jsonl-file.helper.js';
import { SerialQueue } from '../serial-queue/serial-queue.service.js';
import { channelFullMarkerSchema, storedChannelEntrySchema } from './channel-entry.validator.js';
import type { ChannelScan, ChannelSeen } from './channel-file.types.js';
import { isLogDamage, readIndex, scanChannel, writeIndex } from './channel-index.helper.js';
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
  readonly #indexFile: string;
  readonly #channel: string;
  readonly #quota: ChannelQuota;
  readonly #every: number;
  readonly #queue = new SerialQueue();
  #last: ChannelHead | undefined;
  #loaded = false;
  /** How many lines the file holds, and how many bytes they are, as far as this process knows. */
  #count = 0;
  #size = 0;
  /** Where the last line starts. */
  #lastOffset = 0;
  /** Counts each time what the channel knows of the file is replaced, for the reads that began with it. */
  #generation = 0;
  /** A read of the whole log found it damaged: a place that fails is the log's fault, and is not asked again. */
  #verified = false;
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
    indexFile: string;
    channel: string;
    quota: ChannelQuota;
    indexEvery?: number;
  }) {
    this.#file = params.file;
    this.#markerFile = params.markerFile;
    this.#indexFile = params.indexFile;
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
      this.#lastOffset = 0;
      this.#offsets = [];
      this.#verified = false;
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

    this.#lastOffset = this.#size;
    this.#size += Buffer.byteLength(JSON.stringify(kept)) + 1;
    this.#count += 1;
    this.#last = { channel: kept.channel, cursor: kept.cursor, type: kept.type };

    // At the end of each block, and when the channel is finished, so a closed channel is covered whole.
    if (this.#count % this.#every === 0 || kept.type === 'closed') await this.#saveIndex();
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
   * once. Every line it reads is held to the rule an append is, so a file edited by hand into a log
   * with a gap, a repeat or another channel's entry is refused here, as the other logs refuse a
   * gap: all of them, or the ones after the index the channel kept (`readIndex`).
   */
  async #load(): Promise<void> {
    if (this.#loaded) return;

    // First, since it is cheap and a marker that cannot be read fails the load before the log is
    // scanned, which can be gigabytes when there is no index to start from.
    const marker = await readJsonFile({
      file: this.#markerFile,
      schema: channelFullMarkerSchema,
      holdsSecrets: false,
    });

    await this.#quota.ready();
    await trimPartialLine({ file: this.#file });

    const size = await this.#bytesOnDisk();

    this.#quota.settle({ channel: this.#channel, size });

    // Only the lines after what a valid index covers are read; with none, all of them.
    const known = await readIndex({
      file: this.#indexFile,
      logFile: this.#file,
      every: this.#every,
      size,
    });
    const found = await scanChannel({
      file: this.#file,
      channel: this.#channel,
      every: this.#every,
      from: known,
    });

    if (marker !== undefined) {
      this.#refusedFor ??= 'is full';
      this.#marked = true;
    }

    this.#adopt(found);
    this.#size = size;
    this.#loaded = true;

    // A block's worth of lines was read to know this: the next process need not.
    if (found.scanned >= this.#every) await this.#saveIndex();
  }

  /**
   * Writes what the channel knows of its log beside it, for a process that reads it later. A cache:
   * a write that fails costs that process a read of the log, and the next block tries again.
   */
  async #saveIndex(): Promise<void> {
    // A byte channel's log holds a few lines (its output is elsewhere) and keeps none.
    if (!this.#last || this.#count < this.#every || cursorKind(this.#last.cursor) !== 'sequence') {
      return;
    }

    try {
      await writeIndex({
        file: this.#indexFile,
        index: {
          version: 1,
          every: this.#every,
          size: this.#size,
          count: this.#count,
          lastOffset: this.#lastOffset,
          last: this.#last,
          offsets: this.#offsets,
        },
      });
    } catch (caughtError) {
      if (!(caughtError instanceof StorageFileError)) throw caughtError;
    }
  }

  /** What a read begins from: the file as this process knows it now. Call it after `#load`. */
  #seen(): ChannelSeen {
    return {
      count: this.#count,
      offsets: this.#offsets,
      kind: this.#last && cursorKind(this.#last.cursor),
    };
  }

  async *#entriesFrom(from: ChannelFrom, rebuilt = false): AsyncGenerator<ChannelEntry> {
    if (from === 'start') {
      yield* readJsonLines({ file: this.#file, schema: storedChannelEntrySchema });

      return;
    }

    // The file is read whole once in this process (by `#load`), after the appends already queued;
    // a read then begins at the block of lines that holds what it wants.
    const { seen, generation } = await this.#queue.run(async () => {
      await this.#load();

      return { seen: this.#seen(), generation: this.#generation };
    });
    const lines = this.#seek({ from, seen })[Symbol.asyncIterator]();

    // Hand-driven, because a place that is wrong shows at the first line, before anything is given:
    // the read then starts over on the places a read of the whole log made, once. A line that is wrong
    // after the first is the log's damage, not the places', and fails the read as it always did.
    try {
      let next: IteratorResult<ChannelEntry>;

      try {
        next = await lines.next();
      } catch (caughtError) {
        if (rebuilt || !(await this.#indexWasWrong({ error: caughtError, generation }))) {
          throw caughtError;
        }

        yield* this.#entriesFrom(from, true);

        return;
      }

      for (; !next.done; next = await lines.next()) yield next.value;
    } finally {
      await lines.return?.();
    }
  }

  /** The entries `from` asks for, from where `seen` says to begin. */
  #seek(params: {
    from: Exclude<ChannelFrom, 'start'>;
    seen: ChannelSeen;
  }): AsyncIterable<ChannelEntry> {
    const { from, seen } = params;
    const common = { file: this.#file, seen, every: this.#every };

    return 'tail' in from
      ? linesFrom({ ...common, index: Math.max(0, seen.count - from.tail) })
      : entriesAfter({ ...common, channel: this.#channel, cursor: from.after });
  }

  /**
   * Whether `error`, from the first line of a read that began at a place the channel knows, is the
   * place's: the line is not the one it should be, or the place is not the start of a line. The log is
   * read whole to find out, with what the channel knows kept as it is: if every line is well formed
   * the places were wrong, and the ones that read made replace them (and the index is written again);
   * if one is not, the log is damaged and the places were not at fault, so nothing changes, that scan's
   * error is the read's, and the log is not read whole again for the next read that meets the damage
   * (`#verified`). `generation` is what the read began with: a read that failed on places another read
   * has since replaced only starts over.
   */
  async #indexWasWrong(params: { error: unknown; generation: number }): Promise<boolean> {
    const { error, generation } = params;

    if (!(error instanceof ChannelIndexError || error instanceof StorageFileError)) return false;

    if (this.#verified) return false;

    return this.#queue.run(async () => {
      // Checked again here: reads that failed together were all let in above, and the first to scan
      // may have found the damage, which the rest are not to scan for again.
      if (this.#verified) return false;

      if (this.#generation !== generation) return true;

      try {
        this.#adopt(
          await scanChannel({
            file: this.#file,
            channel: this.#channel,
            every: this.#every,
            from: undefined,
          }),
        );
      } catch (caughtError) {
        // Only a line that is not well formed is the log's damage, which a later read need not look
        // for again; a disk that failed to be read may read next time.
        this.#verified = isLogDamage(caughtError);
        throw caughtError;
      }

      await this.#saveIndex();

      return true;
    });
  }

  /** Takes what reading the log found as what the channel knows, and says so to the reads under way. */
  #adopt(found: ChannelScan): void {
    this.#last = found.last;
    this.#count = found.count;
    this.#lastOffset = found.lastOffset;
    this.#offsets = found.offsets;
    this.#generation += 1;
  }
}

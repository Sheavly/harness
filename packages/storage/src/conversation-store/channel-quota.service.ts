import { readdir, stat } from 'node:fs/promises';
import path from 'node:path';
import type { ChannelLimits } from '@sheavly/core/store/store.types';
import { isMissingPath } from '@sheavly/runtime/errors/errors.utils';
import { StorageFileError } from '../errors/storage.errors.js';
import { CHANNEL_LOG_SUFFIX } from './conversation-store.constants.js';

/**
 * What one conversation's channels hold, and the limits they are held to. The bytes are counted
 * from the files on disk once (the first time anything is written), so a conversation that is
 * reopened carries on from what it already holds, and then kept in step by every append: an entry
 * is `reserve`d before it is written, in one step with nothing awaited, so channels writing at the
 * same time cannot together pass a limit that each passes alone.
 *
 * A write that failed may or may not have reached the file, so its reservation is not guessed at:
 * the channel `settle`s, setting what it holds to the size its file really has. A disk that fails
 * a hundred times therefore does not fill a channel's room with entries that were never written.
 */
export class ChannelQuota {
  readonly #folder: string;
  readonly #limits: ChannelLimits;
  readonly #bytes = new Map<string, number>();
  #total = 0;
  #counted: Promise<void> | undefined;
  #generation = 0;

  /** `folder` is the conversation's `channels` folder; it may not exist yet. */
  constructor(params: { folder: string; limits: ChannelLimits }) {
    this.#folder = params.folder;
    this.#limits = params.limits;
  }

  /** Counts what the folder holds, once. Rejects with a `StorageFileError` when it cannot be read. */
  async ready(): Promise<void> {
    const attempt = (this.#counted ??= this.#count());

    try {
      await attempt;
    } catch (caughtError) {
      // A failed count is tried again, not remembered; one that was already replaced is left alone.
      if (this.#counted === attempt) this.#counted = undefined;
      throw caughtError;
    }
  }

  /**
   * Counts the folder again, replacing what is held: what is on disk is what is true. A line that
   * another channel has reserved and not yet written is not on disk, so it is not counted until
   * that channel next reads its file or the folder is counted again: for that moment the limit can
   * be passed by the lines still being written, at most one per channel. It is used only before a
   * refusal that will last, which is the rare case, and never makes a refusal for good on room that
   * a failed write held.
   */
  async recount(): Promise<void> {
    this.#counted = undefined;
    await this.ready();
  }

  /**
   * Holds `size` bytes for `channel`, or says which limit it would pass and holds nothing. Call it
   * after `ready`.
   */
  reserve(params: { channel: string; size: number }): string | undefined {
    const { channel, size } = params;
    const held = this.#bytes.get(channel);

    if ((held ?? 0) + size > this.#limits.channelBytes) return 'is past its size';

    if (this.#total + size > this.#limits.conversationBytes) {
      return 'is past its conversation’s size';
    }

    if (held === undefined && this.#bytes.size >= this.#limits.conversationChannels) {
      return 'is one channel too many for its conversation';
    }

    this.#bytes.set(channel, (held ?? 0) + size);
    this.#total += size;

    return undefined;
  }

  /**
   * Sets what `channel` holds to `size`, the bytes its file really has, and the total with it. A
   * file that is not there is `0`, and the channel is then no channel to count. Call it after
   * `ready`.
   */
  settle(params: { channel: string; size: number }): void {
    const { channel, size } = params;

    this.#total += size - (this.#bytes.get(channel) ?? 0);

    if (size > 0) this.#bytes.set(channel, size);
    else this.#bytes.delete(channel);
  }

  /** Forgets every count, once the conversation's folder is deleted, so it starts from nothing. */
  forget(): void {
    this.#bytes.clear();
    this.#total = 0;
    this.#counted = undefined;
    // A count that is in flight began before the folder went: what it finds is not true any more.
    this.#generation += 1;
  }

  /**
   * Counts the channel logs in the folder. What is counted is kept apart until it is all counted,
   * so a count that fails halfway leaves nothing behind for the next one to add to. A log is a
   * regular file: a link, or anything else, is not one the store made, and is not counted.
   */
  async #count(): Promise<void> {
    const generation = this.#generation;
    let entries;

    try {
      entries = await readdir(this.#folder, { withFileTypes: true });
    } catch (caughtError) {
      if (isMissingPath(caughtError)) return;
      throw new StorageFileError({ file: this.#folder, cause: caughtError });
    }

    const counted = new Map<string, number>();

    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.endsWith(CHANNEL_LOG_SUFFIX)) continue;

      const file = path.join(this.#folder, entry.name);

      try {
        counted.set(entry.name.slice(0, -CHANNEL_LOG_SUFFIX.length), (await stat(file)).size);
      } catch (caughtError) {
        throw new StorageFileError({ file, cause: caughtError });
      }
    }

    if (generation !== this.#generation) return;

    this.#bytes.clear();
    this.#total = 0;

    for (const [channel, size] of counted) {
      this.#bytes.set(channel, size);
      this.#total += size;
    }
  }
}

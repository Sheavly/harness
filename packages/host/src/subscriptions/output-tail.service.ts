import { now } from '@sheavly/core/clock/clock.helper';
import type { StoredChunk } from '@sheavly/core/output/output.types';
import type { ChannelEntry } from '@sheavly/core/store/store.types';
import { MAX_OUTPUT_CHUNK_BYTES } from '@sheavly/protocol/channel/channel.constants';
import { outputEntry, splitByBytes, textFromByte, utf8Bytes } from './output-chunks.utils.js';
import { MAX_EARLY_OUTPUT_BYTES, MAX_QUEUED_FRAMES } from './subscriptions.constants.js';
import type { TailEnd } from './subscriptions.types.js';

/**
 * Text taken but not yet sent: where it starts, the pieces, which are contiguous, and when the first
 * was stored (the entries it makes are stamped with it, so one is never later than the `closed`
 * entry that follows the output).
 */
type Batch = { offset: number; texts: string[]; bytes: number; at: number };

/**
 * The live part of one command's or service's output channel in a subscription: the chunks the
 * capture tells once they are stored, as `output` entries. The history is read from the output
 * store, so a tail has to join the two with no gap and no repeat: it keeps what it is told until
 * `join` says where the history ended, and then sends only what starts there, cutting a chunk that
 * overlaps the end of it. Everything is by byte offset, so the join does not depend on how the
 * store and the capture happen to cut the output.
 *
 * What it takes is sent after at most `delayMs`, or at once when it is a whole entry, in entries of
 * at most `MAX_OUTPUT_CHUNK_BYTES`: a command that prints a little at a time is not a frame for each.
 * It never throws, since it runs inside the capture's own call. `emit` says whether the entry was
 * queued or why the channel must end, and `onEnd` is told of that, from here or from the timer; once
 * a tail has ended, or been stopped, it says nothing more.
 */
export class OutputTail {
  readonly #channel: string;
  readonly #delayMs: number;
  readonly #emit: (entry: ChannelEntry) => TailEnd | undefined;
  readonly #onEnd: (reason: TailEnd) => void;
  /** Told while the history was read, and when, until `join`; undefined after. */
  #early: { chunk: StoredChunk; at: number }[] | undefined = [];
  #earlyBytes = 0;
  #overflowed = false;
  /** The offset after the last byte taken, sent or waiting in the batch. */
  #taken = 0;
  #batch: Batch | undefined;
  #timer: NodeJS.Timeout | undefined;
  #done = false;

  constructor(params: {
    channel: string;
    delayMs: number;
    emit: (entry: ChannelEntry) => TailEnd | undefined;
    onEnd: (reason: TailEnd) => void;
  }) {
    this.#channel = params.channel;
    this.#delayMs = params.delayMs;
    this.#emit = params.emit;
    this.#onEnd = params.onEnd;
  }

  /** The offset after the last byte taken: where a `closed` entry of the channel stands. */
  get taken(): number {
    return this.#taken;
  }

  /** A chunk the capture stored. Kept while the history is read, sent (in time) after. */
  hear(chunk: StoredChunk): void {
    if (this.#done) return;

    if (this.#early === undefined) {
      this.#take({ chunk, at: now() });

      return;
    }

    // Past what a subscription holds while it reads, in chunks or in bytes (one chunk may be
    // megabytes): cut off when joined, and the client reads the rest from the store.
    this.#earlyBytes += utf8Bytes(chunk.text);

    if (this.#early.length >= MAX_QUEUED_FRAMES || this.#earlyBytes > MAX_EARLY_OUTPUT_BYTES) {
      this.#overflowed = true;
      this.#early = [];
    } else {
      this.#early.push({ chunk, at: now() });
    }
  }

  /** The history ended at byte `end`: sends what was told since, from there. */
  join(end: number): void {
    const early = this.#early ?? [];

    this.#taken = end;
    this.#early = undefined;

    if (this.#overflowed) {
      this.#finish('cut_off');

      return;
    }

    for (const told of early) {
      // A refused entry ends the tail: what is left of what was told is not sent after the end.
      if (this.#done) return;

      this.#take(told);
    }
  }

  /** Sends what waits now, before something that follows it (the channel's `closed` entry). */
  flush(): void {
    clearTimeout(this.#timer);
    this.#timer = undefined;

    const batch = this.#batch;

    this.#batch = undefined;

    if (batch) this.#send(batch);
  }

  /** Stops it for good: nothing waiting is sent, and nothing told is heard. Safe to repeat. */
  stop(): void {
    this.#done = true;
    clearTimeout(this.#timer);
    this.#timer = undefined;
    this.#batch = undefined;
  }

  #take(params: { chunk: StoredChunk; at: number }): void {
    const { chunk, at } = params;

    if (this.#done) return;

    const end = chunk.offset + utf8Bytes(chunk.text);

    // Already in the history that was read, or sent before.
    if (end <= this.#taken) return;

    // The store has what lies between: cut off, so the client resumes from its last cursor and
    // reads it, as for a consumer that did not keep up.
    if (chunk.offset > this.#taken) {
      this.#finish('cut_off');

      return;
    }

    const text =
      chunk.offset < this.#taken
        ? textFromByte({ text: chunk.text, skip: this.#taken - chunk.offset })
        : chunk.text;

    this.#add({ told: text, at });
  }

  #add(params: { told: string; at: number }): void {
    const { told, at } = params;
    const batch = (this.#batch ??= { offset: this.#taken, texts: [], bytes: 0, at });
    // The store holds a lone surrogate as U+FFFD (three bytes), and so does this: two halves of a
    // pair told apart must not join into a character of four, or the offsets would not add up.
    const text = told.toWellFormed();
    const bytes = utf8Bytes(text);

    batch.texts.push(text);
    batch.bytes += bytes;
    this.#taken += bytes;

    if (batch.bytes >= MAX_OUTPUT_CHUNK_BYTES) this.flush();
    else this.#timer ??= setTimeout(() => this.flush(), this.#delayMs);
  }

  #send(batch: Batch): void {
    let offset = batch.offset;

    for (const text of splitByBytes({
      text: batch.texts.join(''),
      maxBytes: MAX_OUTPUT_CHUNK_BYTES,
    })) {
      const reason = this.#emit(
        outputEntry({ channel: this.#channel, offset, text, at: batch.at }),
      );

      if (reason) {
        this.#finish(reason);

        return;
      }

      offset += utf8Bytes(text);
    }
  }

  #finish(reason: TailEnd): void {
    if (this.#done) return;

    this.stop();
    this.#onEnd(reason);
  }
}

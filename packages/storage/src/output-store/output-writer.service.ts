import type { FileHandle } from 'node:fs/promises';
import type { OutputWriter, StoredChunk } from '@sheavly/core/output/output.types';
import {
  MAX_LOG_BYTES,
  MAX_PENDING_BYTES,
  OUTPUT_CLOSE_TIMEOUT_MS,
} from '@sheavly/protocol/output/output.constants';
import type { OutputLog, OutputRef } from '@sheavly/protocol/output/output.types';
import { errorCode } from '@sheavly/runtime/errors/errors.utils';
import { OutputFollowers } from '@sheavly/runtime/output/output-followers.service';
import type { WriterLimits } from './output-store.types.js';

/**
 * One capture, written to its file as chunks arrive. Writes run one after another off the
 * command's path, and at most `maxPendingBytes` wait in memory: past that, or past `maxLogBytes`
 * stored, or after a failed write, the log is marked `incomplete` with the reason and later chunks
 * are dropped, so a partial log is never reported as whole. The log reads `capturing` until its
 * record is written: a log that is still closing is never reported `complete`.
 */
export class FileOutputWriter implements OutputWriter {
  readonly #ref: OutputRef;
  readonly #handle: FileHandle;
  readonly #onClosed: (log: OutputLog) => Promise<void>;
  readonly #maxLogBytes: number;
  readonly #maxPendingBytes: number;
  readonly #closeTimeoutMs: number;
  readonly #admit: (bytes: number) => boolean;
  readonly #release: (bytes: number) => void;
  readonly #followers = new OutputFollowers();
  #chain: Promise<void> = Promise.resolve();
  #accepted = 0;
  #pending = 0;
  #written = 0;
  #reason: string | undefined;
  #writeFailed = false;
  #closed = false;
  #settled = false;
  #closing: Promise<OutputLog> | undefined;

  constructor(params: {
    ref: OutputRef;
    handle: FileHandle;
    /** Records the final state durably; its failure makes the log `incomplete`. */
    onClosed: (log: OutputLog) => Promise<void>;
    /** Defaults are the protocol's; a test passes small ones. */
    limits?: Partial<WriterLimits>;
    /** Asks the conversation's quota for `bytes`; false when it has no room left. */
    admit?: (bytes: number) => boolean;
    /** Gives back bytes `admit` took that never reached the file. */
    release?: (bytes: number) => void;
  }) {
    this.#admit = params.admit ?? (() => true);
    this.#release = params.release ?? (() => undefined);
    this.#ref = params.ref;
    this.#handle = params.handle;
    this.#onClosed = params.onClosed;
    this.#maxLogBytes = params.limits?.maxLogBytes ?? MAX_LOG_BYTES;
    this.#maxPendingBytes = params.limits?.maxPendingBytes ?? MAX_PENDING_BYTES;
    this.#closeTimeoutMs = params.limits?.closeTimeoutMs ?? OUTPUT_CLOSE_TIMEOUT_MS;
  }

  get log(): OutputLog {
    return this.#snapshot(this.#settled ? 'complete' : 'capturing');
  }

  append(chunk: string): void {
    if (this.#closed || this.#reason !== undefined) return;

    const bytes = Buffer.from(chunk, 'utf8');

    if (this.#accepted + bytes.length > this.#maxLogBytes) {
      this.#reason = `the stored output reached its ${String(this.#maxLogBytes)}-byte limit; later output was not kept`;

      return;
    }

    if (this.#pending + bytes.length > this.#maxPendingBytes) {
      this.#reason = 'storage could not keep up with the command; later output was not kept';

      return;
    }

    if (!this.#admit(bytes.length)) {
      this.#reason = 'this conversation reached its stored-output limit; later output was not kept';

      return;
    }

    this.#accepted += bytes.length;
    this.#pending += bytes.length;
    this.#chain = this.#chain.then(() => this.#write({ bytes, text: chunk }));
  }

  follow(listener: (chunk: StoredChunk) => void): () => void {
    return this.#followers.follow(listener);
  }

  /** Every caller gets the one close: the handle closes and the record is written once. */
  close(): Promise<OutputLog> {
    this.#closing ??= this.#finish();

    return this.#closing;
  }

  async #finish(): Promise<OutputLog> {
    // `append` refuses new chunks from here on, so what is queued is all there will be.
    this.#closed = true;

    if (!(await this.#drained())) {
      // A stalled disk must not hold the task (or a cancel) forever: say what may be missing.
      this.#reason ??=
        'storage did not finish writing in time; the end of the output may be missing';
      this.#writeFailed = true;
    }

    await this.#closeHandle();

    try {
      // The record is what a reader finds after this log is forgotten: write the final state.
      await this.#onClosed(this.#finalLog());
    } catch (caughtError) {
      this.#fail(caughtError);
    }

    this.#settled = true;

    return this.log;
  }

  /** What the log is once nothing more will be written to it. */
  #finalLog(): OutputLog {
    return this.#snapshot('complete');
  }

  /** The log as it stands: `incomplete` with the reason once anything was lost, else `status`. */
  #snapshot(status: 'capturing' | 'complete'): OutputLog {
    const base = { ref: this.#ref, bytes: this.#written };

    if (this.#reason !== undefined) return { ...base, status: 'incomplete', reason: this.#reason };

    return { ...base, status };
  }

  /** Whether every queued write ended within the close timeout. */
  async #drained(): Promise<boolean> {
    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise<boolean>((resolve) => {
      timer = setTimeout(() => resolve(false), this.#closeTimeoutMs);
    });

    try {
      return await Promise.race([this.#chain.then(() => true), timeout]);
    } finally {
      clearTimeout(timer);
    }
  }

  /** Closes the handle; one that stalls too is given up on after the same wait. */
  async #closeHandle(): Promise<void> {
    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise<void>((resolve) => {
      timer = setTimeout(resolve, this.#closeTimeoutMs);
    });

    try {
      await Promise.race([
        this.#handle.close().catch((caughtError: unknown) => this.#fail(caughtError)),
        timeout,
      ]);
    } finally {
      clearTimeout(timer);
    }
  }

  async #write(chunk: { bytes: Buffer; text: string }): Promise<void> {
    const { bytes, text } = chunk;

    // A limit only stops new chunks; what was accepted before it is still written. A failed or
    // timed-out write stops the rest, since the log would have a hole.
    if (this.#writeFailed) {
      this.#pending -= bytes.length;
      this.#release(bytes.length);

      return;
    }

    const offset = this.#written;
    let stored = false;

    try {
      await this.#handle.appendFile(bytes);
      this.#written += bytes.length;
      stored = true;
    } catch (caughtError) {
      this.#writeFailed = true;
      this.#release(bytes.length);
      this.#fail(caughtError);
    } finally {
      this.#pending -= bytes.length;
    }

    // Told only once it can be read back, and after the bookkeeping above, so a follower that reads
    // the log finds this chunk in it and the size it has. Not inside the `try`: a follower's own
    // failure must not be taken for the file's.
    if (stored) this.#followers.tell({ offset, text });
  }

  #fail(caughtError: unknown): void {
    // The code only: a file system error's message carries the data folder's path, and the reason
    // reaches the model.
    this.#reason ??= `storage failed (${errorCode(caughtError) ?? 'unknown error'})`;
  }
}

import { appendJsonLine } from './jsonl-file.helper.js';

/**
 * Appends JSON lines to one file in the order they are asked for, one at a time. A log sink is not
 * awaited by the logger, so several lines can be asked for before the first is written: each
 * waits for the one before it, and the file holds them in the order they were logged. One
 * `OrderedAppends` per file; a second would order its own lines only.
 */
export class OrderedAppends {
  readonly #file: string;
  #tail: Promise<void> = Promise.resolve();

  constructor(params: { file: string }) {
    this.#file = params.file;
  }

  /**
   * Appends `value` once every earlier line has settled, and rejects with what writing it threw. A
   * line that failed does not stop the ones after it. `unless` is read just before the write: a
   * line it says no to is dropped (a conversation deleted meanwhile must not get its folder back).
   */
  append(params: { value: unknown; unless?: () => boolean }): Promise<void> {
    const write = async () => {
      if (params.unless?.()) return;

      await appendJsonLine({ file: this.#file, value: params.value });
    };
    // Both branches write: an earlier failure was its own caller's to hear of, not this line's.
    const next = this.#tail.then(write, write);

    this.#tail = next;

    return next;
  }

  /** Waits for every line asked for so far to settle, whether it was written, dropped or failed. */
  async settled(): Promise<void> {
    // A failure was reported to the caller that asked for the line; waiting only needs the end.
    await this.#tail.then(settle, settle);
  }
}

function settle(): void {
  return undefined;
}

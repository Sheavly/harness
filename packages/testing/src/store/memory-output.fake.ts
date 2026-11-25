import { randomUUID } from 'node:crypto';
import { OutputError } from '@sheavly/core/errors/output.errors';
import { readLog, searchLog } from '@sheavly/core/output/output-range.helper';
import type {
  ByteSource,
  OutputRange,
  OutputSearch,
  OutputSearchParams,
  OutputStore,
  OutputWriter,
  StoredChunk,
} from '@sheavly/core/output/output.types';
import type { OutputLog, OutputRef } from '@sheavly/protocol/output/output.types';
import { outputRefSchema } from '@sheavly/protocol/output/output.validator';

type CapturedLog = { chunks: Buffer[]; status: OutputLog['status']; reason?: string };

/**
 * Test-only: an `OutputStore` in memory with the rules of the real one. `failWith` makes the
 * next captures reject (`create`) and `failAppends` makes appended chunks fail the log, so a test
 * can see what happens when storage fails.
 */
export class MemoryOutputStore implements OutputStore {
  readonly #logs = new Map<OutputRef, CapturedLog>();
  #createFailure: Error | undefined;
  #refusal: OutputError | undefined;
  #appendFailure: string | undefined;

  /** Every following `create` rejects with `unavailable`; `undefined` mends it. */
  failWith(error: Error | undefined): void {
    this.#createFailure = error;
  }

  /** Every following chunk marks its log incomplete with this reason; `undefined` mends it. */
  failAppends(reason: string | undefined): void {
    this.#appendFailure = reason;
  }

  /** Every following `create` rejects with exactly this error (a quota refusal); `undefined` mends it. */
  refuseWith(error: OutputError | undefined): void {
    this.#refusal = error;
  }

  async create(): Promise<OutputWriter> {
    if (this.#refusal) throw this.#refusal;

    if (this.#createFailure) {
      throw new OutputError({
        reason: 'unavailable',
        message: 'Stored command output is unavailable: storage failed.',
        cause: this.#createFailure,
      });
    }

    const ref = outputRefSchema.parse(randomUUID());
    const entry: CapturedLog = { chunks: [], status: 'capturing' };
    const followers = new Set<(chunk: StoredChunk) => void>();

    this.#logs.set(ref, entry);

    return {
      get log() {
        return snapshot({ ref, entry });
      },
      follow: (listener) => {
        followers.add(listener);

        return () => {
          followers.delete(listener);
        };
      },
      append: (chunk) => {
        if (entry.status !== 'capturing') return;

        if (this.#appendFailure !== undefined) {
          entry.status = 'incomplete';
          entry.reason = this.#appendFailure;

          return;
        }

        const offset = snapshot({ ref, entry }).bytes;

        entry.chunks.push(Buffer.from(chunk, 'utf8'));

        // Stored the moment it is appended: this store has no disk to wait for. A follower that
        // throws does not stop the others or the capture; its error is rethrown on its own.
        for (const listener of [...followers]) {
          try {
            listener({ offset, text: chunk });
          } catch (caughtError) {
            queueMicrotask(() => {
              throw caughtError;
            });
          }
        }
      },
      close: async () => {
        if (entry.status === 'capturing') entry.status = 'complete';

        return snapshot({ ref, entry });
      },
    };
  }

  async log(ref: OutputRef): Promise<OutputLog> {
    return snapshot({ ref, entry: this.#entry(ref) });
  }

  async read(params: { ref: OutputRef; offset: number; maxBytes: number }): Promise<OutputRange> {
    const entry = this.#entry(params.ref);

    return readLog({
      ...params,
      log: snapshot({ ref: params.ref, entry }),
      source: sourceOf(entry),
    });
  }

  async search(params: OutputSearchParams): Promise<OutputSearch> {
    const entry = this.#entry(params.ref);

    return searchLog({
      ...params,
      log: snapshot({ ref: params.ref, entry }),
      source: sourceOf(entry),
    });
  }

  #entry(ref: OutputRef): CapturedLog {
    const entry = this.#logs.get(ref);

    if (!entry) {
      throw new OutputError({
        reason: 'not_found',
        message: `No stored output ${ref} in this conversation.`,
      });
    }

    return entry;
  }
}

function sourceOf(entry: CapturedLog): ByteSource {
  const all = () => Buffer.concat(entry.chunks);

  return {
    size: async () => all().length,
    read: async ({ offset, length }) => all().subarray(offset, offset + length),
  };
}

function snapshot(params: { ref: OutputRef; entry: CapturedLog }): OutputLog {
  const { ref, entry } = params;
  const bytes = entry.chunks.reduce((sum, chunk) => sum + chunk.length, 0);

  return {
    ref,
    bytes,
    status: entry.status,
    ...(entry.reason !== undefined && { reason: entry.reason }),
  };
}

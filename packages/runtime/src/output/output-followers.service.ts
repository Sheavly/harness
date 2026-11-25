import type { StoredChunk } from '@sheavly/core/output/output.types';
import { notifyAll } from '../sessions/listeners.helper.js';

/**
 * Who follows one capture. The writer that stores its chunks tells it each one once it is stored;
 * it tells every follower, one at a time, so a follower that throws does not stop the others or the
 * capture (`notifyAll`: its error is rethrown on its own, after the call).
 */
export class OutputFollowers {
  readonly #listeners = new Set<(chunk: StoredChunk) => void>();

  /** Calls `listener` for each chunk told from now on. Returns the stop. */
  follow(listener: (chunk: StoredChunk) => void): () => void {
    this.#listeners.add(listener);

    return () => {
      this.#listeners.delete(listener);
    };
  }

  /** Tells every follower that `chunk` is stored. */
  tell(chunk: StoredChunk): void {
    notifyAll({ listeners: [...this.#listeners], value: chunk });
  }
}

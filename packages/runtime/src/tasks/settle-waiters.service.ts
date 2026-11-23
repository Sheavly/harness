import { abortableWait } from '../wait/abortable-wait.helper.js';

/**
 * The waits on the next time a task settles: each resolves at the next `wake`, or when its own
 * signal aborts, which drops it. A long-lived signal leaves no listener behind once a wait is over.
 */
export class SettleWaiters {
  #waiters: (() => void)[] = [];

  /** How many waits are open. */
  get count(): number {
    return this.#waiters.length;
  }

  /** Resolves at the next `wake`; aborting drops the wait and resolves it. */
  next(signal?: AbortSignal): Promise<void> {
    return abortableWait({
      signal,
      register: (wake) => this.#waiters.push(wake),
      unregister: (wake) => {
        this.#waiters = this.#waiters.filter((waiter) => waiter !== wake);
      },
    });
  }

  /** Resolves every open wait. */
  wake(): void {
    this.#waiters.splice(0).forEach((wake) => wake());
  }
}

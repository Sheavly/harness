/**
 * What is left of the bytes a conversation's subscriptions may hold together (`MAX_HELD_BYTES`).
 * A subscription takes a frame's bytes when it queues it, and gives them back when its consumer
 * reads the frame or the subscription lets go of it.
 */
export class HeldBytes {
  #left: number;

  constructor(limit: number) {
    this.#left = limit;
  }

  /** Takes `bytes`, or takes nothing and says so when they do not fit. */
  take(bytes: number): boolean {
    if (bytes > this.#left) return false;

    this.#left -= bytes;

    return true;
  }

  /** Gives back `bytes` that were taken. */
  give(bytes: number): void {
    this.#left += bytes;
  }
}

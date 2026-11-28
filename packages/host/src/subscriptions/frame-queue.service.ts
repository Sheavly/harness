import { LIVE_EVENT } from '@sheavly/protocol/subscription/subscription.constants';
import { cursorOfFrame } from './subscription-frames.utils.js';
import { COMPACT_AFTER } from './subscriptions.constants.js';
import type { QueuedFrame } from './subscriptions.types.js';

/**
 * The frames of one subscription waiting for its consumer, in the order they were made, and how
 * many of each channel's came live (`live`), which is what a slow consumer is cut off by: history
 * is read from the store and bounded by the request, live frames are bounded here. The consumer
 * waits on it when it is empty, and whoever pushes wakes it.
 */
export class FrameQueue {
  #items: QueuedFrame[] = [];
  /** Where the next frame to give is: what is before it was given already. */
  #head = 0;
  readonly #live = new Map<string, number>();
  #wake: (() => void) | undefined;

  push(item: QueuedFrame): void {
    this.#items.push(item);

    if (item.live) this.#live.set(item.channel, this.liveQueued(item.channel) + 1);

    this.notify();
  }

  /** The next frame, or none when the queue is empty. */
  shift(): QueuedFrame | undefined {
    const item = this.#items[this.#head];

    if (!item) return undefined;

    this.#head += 1;

    // A drained queue holds nothing of what was read; otherwise the read part is dropped from time
    // to time, not on every shift, which would copy the rest.
    if (this.#head === this.#items.length) {
      this.#items = [];
      this.#head = 0;
    } else if (this.#head >= COMPACT_AFTER && this.#head * 2 >= this.#items.length) {
      this.#items = this.#items.slice(this.#head);
      this.#head = 0;
    }

    if (item.live) this.#live.set(item.channel, this.liveQueued(item.channel) - 1);

    return item;
  }

  /** How many live frames of `channel` wait. */
  liveQueued(channel: string): number {
    return this.#live.get(channel) ?? 0;
  }

  /**
   * Forgets the live frames of `channel` that wait: it was cut off, and its client resumes. Gives
   * the bytes they held.
   */
  dropLive(channel: string): number {
    const waiting = this.#items.slice(this.#head);
    const dropped = waiting.filter((item) => item.channel === channel && item.live);

    this.#items = waiting.filter((item) => item.channel !== channel || !item.live);
    this.#head = 0;
    this.#live.delete(channel);

    return dropped.reduce((sum, item) => sum + item.bytes, 0);
  }

  /** Forgets every frame that waits, and gives the bytes they held. */
  clear(): number {
    const held = this.#items.slice(this.#head).reduce((sum, item) => sum + item.bytes, 0);

    this.#items = [];
    this.#head = 0;
    this.#live.clear();

    return held;
  }

  /**
   * The cursor of the newest frame of `channel` that waits, if one does. A live frame has none and
   * is no position to resume from, so it is passed over for the frame before it.
   */
  lastCursor(channel: string): string | undefined {
    for (let index = this.#items.length - 1; index >= this.#head; index -= 1) {
      const item = this.#items[index];

      if (item?.channel === channel && item.frame.type !== LIVE_EVENT) {
        return cursorOfFrame(item.frame);
      }
    }

    return undefined;
  }

  /** Resolves when a frame is pushed or `notify` is called. */
  wait(): Promise<void> {
    return new Promise((resolve) => {
      this.#wake = resolve;
    });
  }

  /** Wakes the consumer, for a reason other than a frame (it left). */
  notify(): void {
    this.#wake?.();
    this.#wake = undefined;
  }
}

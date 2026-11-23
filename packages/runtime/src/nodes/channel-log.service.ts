import { now } from '@sheavly/core/clock/clock.helper';
import { NodeError } from '../errors/nodes.errors.js';
import { MAX_CHANNEL_ENTRIES } from './nodes.constants.js';
import type { ChannelStart, NodeEntry, NodeRecord, ReadableChannel } from './nodes.types.js';

/**
 * One channel's entries, in memory, numbered 0, 1, 2, … with no gap. Only the newest
 * `MAX_CHANNEL_ENTRIES` stay: a position before them is gone, and a reader starts from a snapshot
 * instead. The registry appends; everything else reads through `ReadableChannel`.
 */
export class ChannelLog implements ReadableChannel {
  #entries: NodeEntry[] = [];
  /** The position of `#entries[0]`. */
  #first = 0;
  #listeners = new Set<(entry: NodeEntry) => void>();

  get next(): number {
    return this.#first + this.#entries.length;
  }

  append(params: { type: NodeEntry['type']; node: NodeRecord }): NodeEntry {
    const entry: NodeEntry = {
      cursor: this.next,
      at: now(),
      type: params.type,
      node: { ...params.node },
    };

    this.#entries.push(entry);

    if (this.#entries.length > MAX_CHANNEL_ENTRIES) {
      this.#entries.shift();
      this.#first += 1;
    }

    for (const listener of [...this.#listeners]) listener(entry);

    return entry;
  }

  read(from: number): NodeEntry[] {
    if (!Number.isInteger(from) || from < this.#first || from > this.next) {
      throw new NodeError({
        reason: 'cursor_out_of_range',
        message: `Position ${String(from)} is outside this channel (${String(this.#first)} to ${String(this.next)})`,
      });
    }

    return this.#entries.slice(from - this.#first);
  }

  follow(listener: (entry: NodeEntry) => void, start: ChannelStart = 'start'): () => void {
    // Read before listening, in one step: nothing can be appended between the two.
    for (const entry of this.read(this.#position(start))) listener(entry);

    this.#listeners.add(listener);

    return () => {
      this.#listeners.delete(listener);
    };
  }

  #position(start: ChannelStart): number {
    if (start === 'start') return this.#first;
    if (start === 'now') return this.next;

    return start;
  }
}

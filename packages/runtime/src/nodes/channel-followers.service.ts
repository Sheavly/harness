import { notifyAll } from '../sessions/listeners.helper.js';
import type { ChannelEvent } from './nodes.types.js';

/**
 * Who follows which stored channel. The writer tells it what it stored; it tells each follower of
 * that channel, one at a time, so a follower that throws does not stop the others or the write
 * (`notifyAll`: its error is rethrown on its own, after the call).
 */
export class ChannelFollowers {
  readonly #listeners = new Map<string, Set<(event: ChannelEvent) => void>>();

  /** Calls `listener` for each event of `channel` from now on. Returns the stop. */
  follow(params: { channel: string; listener: (event: ChannelEvent) => void }): () => void {
    const { channel, listener } = params;
    const listeners = this.#listeners.get(channel) ?? new Set();

    listeners.add(listener);
    this.#listeners.set(channel, listeners);

    return () => {
      listeners.delete(listener);

      if (listeners.size === 0 && this.#listeners.get(channel) === listeners) {
        this.#listeners.delete(channel);
      }
    };
  }

  /** Tells every follower of `channel` that `event` happened. */
  tell(params: { channel: string; event: ChannelEvent }): void {
    const listeners = this.#listeners.get(params.channel);

    if (listeners) notifyAll({ listeners: [...listeners], value: params.event });
  }
}

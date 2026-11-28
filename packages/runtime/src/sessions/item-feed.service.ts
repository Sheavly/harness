import { deepFreeze, notifyAll } from './listeners.helper.js';
import type { ItemListener, PublishedItem } from './sessions.types.js';

/**
 * Where the items a session's loop makes are heard, beside the combined stream and never in it:
 * nothing is numbered, kept or replayed here. A listener hears an item at the moment it is
 * published and in the order it was published, which is the order the loop made it in, because
 * listeners are called synchronously. One that throws is isolated as the registry's other
 * listeners are (`notifyAll`), and each is handed a frozen copy, as entries are.
 */
export class ItemFeed {
  readonly #listeners = new Set<ItemListener>();

  /** Calls `listener` for every item published from now on. Returns a function that stops it. */
  subscribe(listener: ItemListener): () => void {
    this.#listeners.add(listener);

    return () => {
      this.#listeners.delete(listener);
    };
  }

  /**
   * Tells every listener, now, about `item`: one frozen copy, as entries are. An item's tool input,
   * reasoning state and artifacts are the run's own objects (the history's, and the next model
   * call's), so a listener must not be handed them to change, or to change what another hears.
   */
  publish(item: PublishedItem): void {
    notifyAll({ listeners: [...this.#listeners], value: deepFreeze(structuredClone(item)) });
  }
}

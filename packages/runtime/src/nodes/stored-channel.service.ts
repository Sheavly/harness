import { now } from '@sheavly/core/clock/clock.helper';
import { StoreError } from '@sheavly/core/errors/store.errors';
import type { ChannelEntry, ChannelLog } from '@sheavly/core/store/store.types';
import { toStoreError } from '@sheavly/core/store/store.utils';
import type { ConversationChannelName } from '@sheavly/protocol/channel/channel.types';
import type { ConversationSnapshot } from '@sheavly/protocol/subscription/subscription.types';
import { notifyAll } from '../sessions/listeners.helper.js';
import { ChannelFollowers } from './channel-followers.service.js';
import type { ChannelEvent } from './nodes.types.js';
import type {
  ChannelPlace,
  ChannelStamp,
  StoredChannelOptions,
  StoredEntry,
} from './stored-channel.types.js';

/**
 * One channel of the conversation itself, stored: it numbers each entry it is told (0, 1, 2, … with
 * no gap, the channel's own cursor), writes them one after another in the order they were told,
 * and keeps the view the entries the store has taken build (`apply`) beside the cursor of the last,
 * so `snapshot` is the view of exactly those entries: a client that starts from it and follows from
 * its cursor gets what one that replayed the channel from the start gets. The tree's writer and
 * usage's extend it, and add what tells them entries (`tell`, which only a writer calls).
 *
 * A write that fails leaves the channel as it was: it takes no more entries, so a log never reads
 * as whole with an entry missing. The first failure is told to `onFailure`; the run goes on.
 */
export class StoredChannel<Entry extends StoredEntry, View, Snapshot extends ConversationSnapshot> {
  readonly name: ConversationChannelName;
  readonly #options: StoredChannelOptions<Entry, View, Snapshot>;
  readonly #log: ChannelLog;
  readonly #followers = new ChannelFollowers();
  /** The position the next entry told gets. */
  #next = 0;
  /** Every write, one after another. Never rejects: a failure is told, not thrown. */
  #written: Promise<void> = Promise.resolve();
  #failure: StoreError | undefined;
  /** The view the stored entries build, and the last of them. */
  #view: View;
  #last: ChannelPlace | undefined;
  /** The writer was stopped: no entry is told after it. */
  #stopped = false;
  /** Whether it stopped or failed and what was told is written: nothing more will be. */
  #ended = false;

  constructor(options: StoredChannelOptions<Entry, View, Snapshot>) {
    this.name = options.name;
    this.#options = options;
    this.#log = options.log;
    this.#view = options.empty;

    const { resumed } = options;

    if (resumed && 'failure' in resumed) {
      // Gone on from nothing it can read: the channel is left as it is, and the failure is told.
      this.#ended = true;
      this.#fail(resumed.failure);
    } else if (resumed) {
      this.#next = resumed.next;
      this.#view = resumed.view;
      this.#last = resumed.last;
    }
  }

  /** The view the stored entries build so far: what a reopened channel resumed with, then each write. */
  get view(): View {
    return this.#view;
  }

  /** The first failed write, if any. The channel takes no more entries after it. */
  get failure(): StoreError | undefined {
    return this.#failure;
  }

  /** Resolves once every entry told so far has been written, or its write has failed. */
  flush(): Promise<void> {
    return this.#written;
  }

  /**
   * The view as the stored entries leave it, with the cursor of the last: what a client starts
   * from, then follows after that cursor. Waits for the entries told so far to be stored first.
   * Rejects with the failure once the channel has failed, whatever it stored before: it takes no
   * more entries, so the view would stand still while the conversation went on, and a client that
   * took it for the view as it is would be wrong without any sign. A writer that was only stopped
   * (the conversation closed) still gives the view it left.
   */
  async snapshot(): Promise<Snapshot> {
    await this.#written;

    if (this.#failure) throw this.#failure;

    if (!this.#last) {
      throw new StoreError({
        reason: 'failed',
        message: `The ${this.name} channel holds nothing yet`,
      });
    }

    return this.#options.snapshotOf({ view: this.#view, ...this.#last });
  }

  /**
   * Calls `listener` for each entry of the channel the store takes from now on, with its place in
   * the log (the entry's number), and once if the channel fails. Returns the stop. What was stored
   * before is the store's: read it after following, and skip the entries it already held.
   */
  follow(listener: (event: ChannelEvent) => void): () => void {
    return this.#followers.follow({ channel: this.name, listener });
  }

  /**
   * Whether this writer may still write the channel: it has not failed or been stopped, or what
   * was told before it stopped is not all written yet. After it, a reader that reaches the end of
   * the stored channel has a channel nothing writes.
   */
  writing(): boolean {
    return !this.#ended;
  }

  /**
   * Numbers the entry `build` makes, here and now, and queues its write. A channel that failed or
   * was closed takes no more, and its position is not used.
   */
  protected tell(build: (stamp: ChannelStamp) => ChannelEntry): void {
    if (this.#ended || this.#stopped) return;

    const entry = build({ position: this.#next, at: now() });

    this.#next += 1;
    this.#written = this.#written.then(() => this.#store(entry));
  }

  /**
   * Stops writing, for a conversation that was closed. The channel is not closed: a closed channel
   * takes no more entries, and the conversation, kept in the store, can be reopened and go on from
   * the last one. What was told is written first, then the followers are told nothing more will come
   * (as for a channel that failed: no writer has it). Safe to repeat; resolves once it is done.
   */
  stop(): Promise<void> {
    if (this.#stopped) return this.#written;

    this.#stopped = true;
    this.#written = this.#written.then(() => {
      if (this.#ended) return;

      this.#ended = true;
      this.#followers.tell({ channel: this.name, event: { type: 'failed' } });
    });

    return this.#written;
  }

  /** Writes `entry`, then keeps the view it makes and tells the followers; a failure ends the channel. */
  async #store(entry: ChannelEntry): Promise<void> {
    if (this.#ended) return;

    try {
      // An entry no client could read is never stored: the channel is the contract's, not ours.
      const parsed = this.#options.schema.safeParse(entry);

      if (!parsed.success) throw parsed.error;

      await this.#log.append(entry);
      this.#view = this.#options.apply({ view: this.#view, entry: parsed.data });
      this.#last = { cursor: entry.cursor, at: entry.at };
      this.#followers.tell({
        channel: this.name,
        event: { type: 'stored', entry, ordinal: Number(entry.cursor.slice(1)) },
      });
    } catch (caughtError) {
      this.#ended = true;
      this.#followers.tell({ channel: this.name, event: { type: 'failed' } });
      this.#fail(caughtError);
    }
  }

  #fail(caughtError: unknown): void {
    if (this.#failure) return;

    this.#failure = toStoreError({
      error: caughtError,
      message: `Could not store the conversation’s ${this.name} channel`,
    });

    if (this.#options.onFailure) {
      // Like a listener: a throw must not reject `#written`, which every later write chains on.
      notifyAll({ listeners: [this.#options.onFailure], value: this.#failure });
    }
  }
}

import type { StoreError } from '@sheavly/core/errors/store.errors';
import type { ChannelLog } from '@sheavly/core/store/store.types';
import type { ConversationChannelName } from '@sheavly/protocol/channel/channel.types';

/** The place and time every entry of a conversation's own channel has, whatever else it holds. */
export type StoredEntry = { type: string; cursor: string; at: number };

/** Where a stored channel stands: its last entry's cursor, and when it was written. */
export type ChannelPlace = { cursor: string; at: number };

/** What a writer is given to number an entry it is told: its place in the channel, and the time. */
export type ChannelStamp = { position: number; at: number };

/**
 * A stored channel as a reopened conversation finds it: where it stands (`next` is the position of
 * the next entry, `last` the entry before it) and the view its entries build, or why it cannot be
 * gone on from (a damaged entry, a channel that ends in `closed`, a disk that fails), in which case
 * the channel is not written and the failure is told.
 */
export type ResumedChannel<View> =
  { next: number; last: ChannelPlace; view: View } | { failure: StoreError };

/** What checks an entry against its channel's contract: zod's `safeParse`, as far as it is used. */
export type EntrySchema<Entry> = {
  safeParse: (
    input: unknown,
  ) => { success: true; data: Entry } | { success: false; error: unknown };
};

/** How a channel of the conversation itself is stored: what it holds, and the view it builds. */
export type StoredChannelOptions<Entry extends StoredEntry, View, Snapshot> = {
  name: ConversationChannelName;
  log: ChannelLog;
  /** The channel's contract: an entry it does not accept is never stored. */
  schema: EntrySchema<Entry>;
  /** The view before any entry. */
  empty: View;
  /** The one rule from an entry to the view. */
  apply: (params: { view: View; entry: Entry }) => View;
  /** The view as the entries stored leave it, at the cursor of the last. */
  snapshotOf: (params: { view: View; cursor: string; at: number }) => Snapshot;
  onFailure?: ((failure: StoreError) => void) | undefined;
  resumed?: ResumedChannel<View> | undefined;
};

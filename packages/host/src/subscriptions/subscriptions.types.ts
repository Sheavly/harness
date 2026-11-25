import type { ChannelEntry, ChannelLog } from '@sheavly/core/store/store.types';
import type { ChannelEvent } from '@sheavly/runtime/nodes/nodes.types';
import type { CursorKind } from '@sheavly/protocol/channel/channel.types';
import type {
  ChannelName,
  SubscribeFrame,
} from '@sheavly/protocol/subscription/subscription.types';

/** A channel of a request that exists in its conversation, with where to start in it. */
export type ResolvedChannel = {
  channel: ChannelName;
  from: string;
  log: ChannelLog;
  /** What its cursors count, read from its first entry. */
  kind: CursorKind;
};

/** What reading one channel's log gives a subscription, once. */
export type Selection = {
  /** The entries to send first, oldest first: what the position asked for. */
  entries: ChannelEntry[];
  /** How many entries the log held when it was read: the place the next one has (`ordinal`). */
  count: number;
  /**
   * Where the log stood and how it ended: the cursor and type of the newest entry it held, and not
   * the entry, which can be large and is not counted against the pool.
   */
  newest: Pick<ChannelEntry, 'cursor' | 'type'>;
  /** The bytes of the conversation's pool the entries hold, until they are queued as frames. */
  held: number;
};

/** A frame waiting for the consumer, and the channel it belongs to. */
export type QueuedFrame = {
  frame: SubscribeFrame;
  channel: string;
  /** Told by the writer after the subscription opened, not read from the store. */
  live: boolean;
  /** What it counts against the conversation's held bytes: its JSON, none for a control frame. */
  bytes: number;
};

/** What a subscription holds for one of its channels. */
export type ChannelState = {
  /** Stops the writer telling this subscription of the channel. */
  stop: () => void;
  /** What the writer told while the store was being read, until it is joined with it. */
  early: ChannelEvent[] | undefined;
  /** The writer told more than a subscription holds while the store was read: cut off when joined. */
  overflowed: boolean;
  /** The place of the first entry the read did not hold: told entries before it are repeats. */
  acceptFrom: number;
  /** The channel ended for this subscription: no more frames of it. */
  ended: boolean;
  /** The cursor of the last frame of the channel the consumer took. */
  delivered: string | undefined;
};

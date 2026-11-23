/** What a cursor counts: the entries of a channel (`sequence`) or the bytes of its output (`byte`). */
export type CursorKind = 'sequence' | 'byte';

/** What a channel's log is checked by, whatever else an entry holds. */
export type ChannelHead = {
  channel: string;
  cursor: string;
  type: string;
};

import type { CursorKind } from '@sheavly/protocol/channel/channel.types';

/**
 * What a read of a channel's file begins from, as it stood when the read began: how many lines the
 * file held, where every `every`th of them starts (the block a line is in is found by its number),
 * and what its cursors count (`undefined` for a file with no line). The read goes no further than
 * `count`, so an entry appended while it runs is for the next read.
 */
export type ChannelSeen = {
  count: number;
  offsets: readonly number[];
  kind: CursorKind | undefined;
};

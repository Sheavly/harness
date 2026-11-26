import type { z } from 'zod';
import type { ChannelHead, CursorKind } from '@sheavly/protocol/channel/channel.types';
import type { channelIndexSchema } from './channel-index.validator.js';

/** What a channel keeps beside its log (`channelIndexSchema`). */
export type ChannelIndex = z.infer<typeof channelIndexSchema>;

/**
 * What reading a channel's log found: how many lines it holds, where every `every`th starts, where
 * the last starts and what it was, and how many lines were read to know it (all of them, or the
 * ones after an index).
 */
export type ChannelScan = {
  count: number;
  offsets: number[];
  last: ChannelHead | undefined;
  lastOffset: number;
  scanned: number;
};

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

import type { ChannelEntry } from '@sheavly/core/store/store.types';
import { channelEntrySchema } from '@sheavly/protocol/channel/channel.validator';
import { TREE_CHANNEL_NAME } from '@sheavly/protocol/node/node.constants';
import { treeChannelEntrySchema } from '@sheavly/protocol/tree/tree.validator';
import { END_EVENT, HEAD_EVENT } from '@sheavly/protocol/subscription/subscription.constants';
import type {
  ChannelEndFrame,
  ChannelHeadFrame,
  ChannelName,
  ServedEntry,
  SubscribeFrame,
} from '@sheavly/protocol/subscription/subscription.types';

/**
 * A stored entry as the wire serves it, checked against the contract once, here: undefined for one
 * that is not what the contract says an entry is (a damaged or older file), which ends its channel
 * as failed rather than sending a frame no client could read.
 */
export function entryFrame(entry: ChannelEntry): ServedEntry | undefined {
  const parsed =
    entry.channel === TREE_CHANNEL_NAME
      ? treeChannelEntrySchema.safeParse(entry)
      : channelEntrySchema.safeParse(entry);

  return parsed.success ? parsed.data : undefined;
}

/** Where `channel` stood when a subscription at `now` opened. */
export function headFrame(params: { channel: ChannelName; cursor: string }): ChannelHeadFrame {
  return { type: HEAD_EVENT, channel: params.channel, cursor: params.cursor };
}

/** `channel` ended for this subscription, with the last cursor it was sent, when it was sent one. */
export function endFrame(params: {
  channel: ChannelName;
  reason: ChannelEndFrame['reason'];
  cursor: string | undefined;
}): ChannelEndFrame {
  const { channel, reason, cursor } = params;

  return { type: END_EVENT, channel, reason, ...(cursor !== undefined && { cursor }) };
}

/**
 * What a frame counts against the conversation's held bytes: the JSON of an entry, or of a
 * snapshot. The two control frames count nothing, so an `end` can always be queued however much is
 * held.
 */
export function bytesOfFrame(frame: SubscribeFrame): number {
  return frame.type === HEAD_EVENT || frame.type === END_EVENT ? 0 : JSON.stringify(frame).length;
}

/** The cursor a frame carries: an entry's, a head's, or an end's when it has one. */
export const cursorOfFrame = (frame: SubscribeFrame): string | undefined =>
  'cursor' in frame ? frame.cursor : undefined;

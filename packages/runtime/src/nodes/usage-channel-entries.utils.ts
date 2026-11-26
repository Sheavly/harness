import type { ChannelEntry } from '@sheavly/core/store/store.types';
import { USAGE_CHANNEL_NAME } from '@sheavly/protocol/node/node.constants';
import type { NodeUsageChange } from '../usage/usage.types.js';
import { sequenceCursor } from './node-channel-entries.utils.js';
import type { ChannelStamp } from './stored-channel.types.js';

/** What every entry of the usage channel has. */
const stamped = ({ position, at }: ChannelStamp) => ({
  channel: USAGE_CHANNEL_NAME,
  cursor: sequenceCursor(position),
  at,
});

/**
 * The first entry of the usage channel: the conversation opened it. With `earlierUncounted`, it
 * says the conversation had already made calls this channel did not count.
 */
export function usageOpenedEntry(
  params: ChannelStamp & { earlierUncounted: boolean },
): ChannelEntry {
  return {
    ...stamped(params),
    type: 'opened',
    ...(params.earlierUncounted && { earlierUncounted: true }),
  };
}

/**
 * A node's usage changed: its figures and the total as they now are, and the nodes whose records
 * were dropped, left out when none were.
 */
export function nodeUsageEntry(params: ChannelStamp & NodeUsageChange): ChannelEntry {
  const { usage, total, evicted } = params;

  return {
    ...stamped(params),
    type: 'node_usage',
    usage,
    total,
    ...(evicted.length > 0 && { evicted }),
  };
}

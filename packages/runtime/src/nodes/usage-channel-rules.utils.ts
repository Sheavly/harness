import { USAGE_CHANNEL_NAME } from '@sheavly/protocol/node/node.constants';
import { usageChannelEntrySchema } from '@sheavly/protocol/usage/usage-channel.validator';
import type { UsageChannelEntry, UsageView } from '@sheavly/protocol/usage/usage.types';
import { applyUsageEntry, emptyUsage, usageSnapshotOf } from '@sheavly/protocol/usage/usage.utils';

/**
 * What makes the usage channel the channel it is, for whatever stores or reads it: its name, the
 * contract its entries keep, the usage before any entry, the one rule from an entry to the usage,
 * and how a snapshot is made of it. The writer, the reader of a stored channel and a test of the
 * stored channel all take it from here. `empty` is made when it is read, so each of them spreads
 * the rules with an empty usage of its own, never one shared by every conversation.
 */
export const usageChannelRules = {
  name: USAGE_CHANNEL_NAME,
  schema: usageChannelEntrySchema,
  get empty() {
    return emptyUsage();
  },
  apply: ({ view, entry }: { view: UsageView; entry: UsageChannelEntry }) =>
    applyUsageEntry({ usage: view, entry }),
  snapshotOf: ({ view, cursor, at }: { view: UsageView; cursor: string; at: number }) =>
    usageSnapshotOf({ usage: view, cursor, at }),
} as const;

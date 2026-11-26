import type { z } from 'zod';
import type {
  nodeUsageSchema,
  usageChannelEntrySchema,
  usageSnapshotSchema,
} from './usage-channel.validator.js';
import type {
  contextFillSchema,
  contextUsageSchema,
  modelUsageSchema,
  tokenUsageSchema,
  usageFiguresSchema,
  usageTotalsSchema,
} from './usage.validator.js';

export type TokenUsage = z.infer<typeof tokenUsageSchema>;
export type ModelUsage = z.infer<typeof modelUsageSchema>;
export type UsageTotals = z.infer<typeof usageTotalsSchema>;
export type ContextUsage = z.infer<typeof contextUsageSchema>;
/** How full an agent's context was at its last counted call. */
export type ContextFill = z.infer<typeof contextFillSchema>;
/** What model calls have used: one node's, or the sum of every node's. */
export type UsageFigures = z.infer<typeof usageFiguresSchema>;
/** What one node's model calls have used. */
export type NodeUsage = z.infer<typeof nodeUsageSchema>;
/** One entry of the usage channel. */
export type UsageChannelEntry = z.infer<typeof usageChannelEntrySchema>;
/** The usage as it stands: the total and each node's, with the cursor to follow the channel from. */
export type UsageSnapshot = z.infer<typeof usageSnapshotSchema>;
/** The usage a client holds: the snapshot's total and nodes, kept by `applyUsageEntry`. */
export type UsageView = { total: UsageFigures; nodes: NodeUsage[] };

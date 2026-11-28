import { z } from 'zod';
import { usageClosedSchema, usageOpenedSchema } from '../channel/channel.validator.js';
import { sequenceCursorSchema } from '../channel/cursor.validator.js';
import { MAX_TREE_NODES, USAGE_CHANNEL_NAME } from '../node/node.constants.js';
import { nodeIdSchema } from '../node/node.validator.js';
import { timestampSchema } from '../time/time.validator.js';
import { contextFillSchema, usageFiguresSchema } from './usage.validator.js';

/**
 * What one node's model calls have used. Only an agent calls a model, so `context`, how full its
 * window is, is an agent's too; a node that made no call has no record.
 */
export const nodeUsageSchema = usageFiguresSchema.extend({
  node: nodeIdSchema,
  context: contextFillSchema.exactOptional(),
});

/** What every entry of the usage channel has: it is numbered, and says when it was written. */
const usageEntrySchema = z.object({
  channel: z.literal(USAGE_CHANNEL_NAME),
  cursor: sequenceCursorSchema,
  at: timestampSchema,
});

/**
 * A node's usage changed: a model call reported, or a turn ended with none. It carries the node's
 * figures and the conversation's total as they now are, not what was added, so a client replaces
 * what it holds, an entry told twice does no harm, and nothing is summed on the client.
 *
 * `evicted` is the nodes whose records are no longer kept, left out when there are none: a
 * conversation that has run more nodes than a snapshot holds drops the records of its oldest ended
 * nodes, and their calls stay in the total. A client drops them too.
 */
export const nodeUsageEntrySchema = usageEntrySchema.extend({
  type: z.literal('node_usage'),
  usage: nodeUsageSchema,
  total: usageFiguresSchema,
  evicted: z.array(nodeIdSchema).max(MAX_TREE_NODES).exactOptional(),
});

/**
 * One entry of a conversation's usage channel: the conversation opening and closing it, and each
 * change of a node's usage. A cost view and a status line read only this channel.
 */
export const usageChannelEntrySchema = z.discriminatedUnion('type', [
  usageOpenedSchema,
  usageClosedSchema,
  nodeUsageEntrySchema,
]);

/**
 * The usage as it stands, sent first when a client asks for it: the conversation's total, and the
 * record of each node that has made a call, in the order they first did. `cursor` is the entry of
 * the usage channel it covers up to, so the client continues after it. It is a view and is not kept
 * in the channel's log. Each node is in it once. The total covers every call, and the nodes at most
 * `MAX_TREE_NODES` of them: the records of the oldest ended nodes are left out past that, their
 * calls still in the total.
 */
export const usageSnapshotSchema = z
  .object({
    channel: z.literal(USAGE_CHANNEL_NAME),
    cursor: sequenceCursorSchema,
    at: timestampSchema,
    type: z.literal('snapshot'),
    total: usageFiguresSchema,
    nodes: z.array(nodeUsageSchema).max(MAX_TREE_NODES),
  })
  .refine(({ nodes }) => new Set(nodes.map(({ node }) => node)).size === nodes.length, {
    error: 'a snapshot has each node once',
    path: ['nodes'],
  });

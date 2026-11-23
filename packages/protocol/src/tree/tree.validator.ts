import { z } from 'zod';
import {
  approvalIdSchema,
  approvalRequestSchema,
  approvalResponseSchema,
} from '../approval/approval.validator.js';
import {
  sequenceCursorSchema,
  treeClosedSchema,
  treeOpenedSchema,
} from '../channel/channel.validator.js';
import {
  extensionEnvelopeShape,
  extensionQualifiedNameSchema,
} from '../extension/extension.validator.js';
import { isInNamespace } from '../extension/extension.utils.js';
import { messageIdSchema } from '../message/message.validator.js';
import {
  MAX_NODE_ERROR_CHARS,
  MAX_TREE_NODES,
  RESERVED_EXTENSION_NAMES,
  TREE_CHANNEL_NAME,
} from '../node/node.constants.js';
import { isReservedExtensionName } from '../node/node.utils.js';
import { nodeIdSchema, nodeInfoSchema } from '../node/node.validator.js';
import { MAX_QUEUED_LINE_CHARS } from '../server/server.constants.js';
import { queuedPromptsSchema } from '../server/server.validator.js';
import { NODE_END_STATES } from '../status/status.constants.js';
import { timestampSchema } from '../time/time.validator.js';
import { isConsistentSnapshot } from './tree.utils.js';

/** What every entry of the tree channel has: it is numbered, and says when it was written. */
const treeEntrySchema = z.object({
  channel: z.literal(TREE_CHANNEL_NAME),
  cursor: sequenceCursorSchema,
  at: timestampSchema,
});

/** Whether `state` is one a node ends in. */
const isEnded = (state: string) => z.enum(NODE_END_STATES).safeParse(state).success;

/** A node came to be: running, or idle when it is an agent between prompts. */
const nodeOpenedEntrySchema = treeEntrySchema
  .extend({ type: z.literal('node_opened'), node: nodeInfoSchema })
  .refine(({ node }) => !isEnded(node.state), {
    error: 'a node that opens has not ended',
    path: ['node', 'state'],
  });

/** A node changed while it lives: its state between running and idle, its status text, its model. */
const nodeUpdatedEntrySchema = treeEntrySchema
  .extend({ type: z.literal('node_updated'), node: nodeInfoSchema })
  .refine(({ node }) => !isEnded(node.state), {
    error: 'a node that is updated has not ended; its end is node_closed',
    path: ['node', 'state'],
  });

/** A node ended, in the state it is now in for good. */
const nodeClosedEntrySchema = treeEntrySchema
  .extend({ type: z.literal('node_closed'), node: nodeInfoSchema })
  .refine(({ node }) => isEnded(node.state), {
    error: 'a node that closes has ended',
    path: ['node', 'state'],
  });

/**
 * A node's tool asks the user for approval. The node is the one that asked, for display: an
 * approval is answered by its id inside its own conversation, and the node never authorizes it.
 */
const approvalRequestedEntrySchema = treeEntrySchema.extend({
  type: z.literal('approval_requested'),
  node: nodeIdSchema,
  request: approvalRequestSchema,
});

/** A waiting approval was answered. */
const approvalResolvedEntrySchema = treeEntrySchema.extend({
  type: z.literal('approval_resolved'),
  node: nodeIdSchema,
  id: approvalIdSchema,
  response: approvalResponseSchema,
});

/** A waiting approval was given up before anyone answered: its call was interrupted. */
const approvalCancelledEntrySchema = treeEntrySchema.extend({
  type: z.literal('approval_cancelled'),
  node: nodeIdSchema,
  id: approvalIdSchema,
});

/** A line joined the conversation's queue, or a client replaced the lines. */
const queueChangedEntrySchema = treeEntrySchema.extend({
  type: z.literal('queue_changed'),
  queued: queuedPromptsSchema.shape.queued,
});

/**
 * A queued line started as the conversation's next prompt. It names the user message it became,
 * so a follower knows which run it starts without one order across channels.
 */
const promptStartedEntrySchema = treeEntrySchema.extend({
  type: z.literal('prompt_started'),
  text: z.string().max(MAX_QUEUED_LINE_CHARS),
  messageId: messageIdSchema,
  queued: queuedPromptsSchema.shape.queued,
});

/** A line left the queue without starting, for the reason `error` gives. */
const promptRefusedEntrySchema = treeEntrySchema.extend({
  type: z.literal('prompt_refused'),
  text: z.string().max(MAX_QUEUED_LINE_CHARS),
  error: z.string().max(MAX_NODE_ERROR_CHARS),
  queued: queuedPromptsSchema.shape.queued,
});

/** The conversation could not be stored. Said once when writes start failing; it ends no run. */
const storageFailedEntrySchema = treeEntrySchema.extend({
  type: z.literal('storage_failed'),
  error: z.string().max(MAX_NODE_ERROR_CHARS),
});

/**
 * An extension's own event, outside any node: an open envelope, so a reader that does not know the
 * kind shows its `text`. The one an extension's node kind sends on that node's channel is its own.
 */
const extensionEventEntrySchema = treeEntrySchema
  .extend({
    type: z.literal('extension_event'),
    ...extensionEnvelopeShape,
    kind: extensionQualifiedNameSchema,
  })
  .refine((entry) => isInNamespace({ extension: entry.extension, name: entry.kind }), {
    error: 'kind must start with "<extension>."',
    path: ['kind'],
  })
  .refine((entry) => !isReservedExtensionName(entry.extension), {
    error: `the extension is one of ${RESERVED_EXTENSION_NAMES.join(', ')}, which are ours`,
    path: ['extension'],
  });

/**
 * One entry of a conversation's tree channel: what exists (a node opening, changing, closing),
 * what waits for the user (an approval), and the conversation's own notices (its queue, a storage
 * failure, an extension's event). A sidebar, a conversations list and a notification read only
 * this channel.
 */
export const treeChannelEntrySchema = z.discriminatedUnion('type', [
  treeOpenedSchema,
  treeClosedSchema,
  nodeOpenedEntrySchema,
  nodeUpdatedEntrySchema,
  nodeClosedEntrySchema,
  approvalRequestedEntrySchema,
  approvalResolvedEntrySchema,
  approvalCancelledEntrySchema,
  queueChangedEntrySchema,
  promptStartedEntrySchema,
  promptRefusedEntrySchema,
  storageFailedEntrySchema,
  extensionEventEntrySchema,
]);

/**
 * The tree as it stands, sent first when a client asks for it, so a sidebar needs no more: every
 * node, an ended one included, and every approval still waiting. `cursor` is the entry of the tree
 * channel it covers up to, so the client continues after it. It is a view and is not kept in the
 * channel's log. It holds together (`isConsistentSnapshot`): each node once, each parent among
 * them and none in a circle, each approval once and asked by a node in it. It holds at most
 * `MAX_TREE_NODES` nodes and as many approvals, which the node registry enforces as it spawns.
 */
export const treeSnapshotSchema = z
  .object({
    channel: z.literal(TREE_CHANNEL_NAME),
    cursor: sequenceCursorSchema,
    at: timestampSchema,
    type: z.literal('snapshot'),
    nodes: z.array(nodeInfoSchema).max(MAX_TREE_NODES),
    approvals: z
      .array(z.object({ node: nodeIdSchema, request: approvalRequestSchema }))
      .max(MAX_TREE_NODES),
  })
  .refine(isConsistentSnapshot, {
    error:
      'a snapshot has each node once, each parent in it and none in a circle, and each approval once from a node in it',
    path: ['nodes'],
  });

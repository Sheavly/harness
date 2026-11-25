import { z } from 'zod';
import { MAX_NODE_ERROR_CHARS, TREE_CHANNEL_NAME } from '../node/node.constants.js';
import { nodeIdSchema, nodeInfoSchema } from '../node/node.validator.js';
import { runOutcomeSchema } from '../session/session.validator.js';
import { NODE_END_STATES, NODE_STATE_OF_OUTCOME } from '../status/status.constants.js';
import { timestampSchema } from '../time/time.validator.js';
import {
  BYTE_CURSOR_PATTERN,
  MAX_ENTRY_TYPE_CHARS,
  SEQUENCE_CURSOR_PATTERN,
} from './channel.constants.js';
import {
  channelCursorKinds,
  cursorKind,
  cursorNumber,
  isWellFormedChannelLog,
} from './channel.utils.js';

/**
 * A position in a channel that numbers its entries: `s` and the position, 0, 1, 2, … with no gaps.
 * The tree channel and an agent's channel use it. Opaque to a client, which keeps the last one it
 * saw and sends it back.
 */
export const sequenceCursorSchema = z
  .string()
  .regex(SEQUENCE_CURSOR_PATTERN, 'must be s and a position');

/**
 * A position in the output of a command or a service: `b` and an offset in bytes. Opaque to a
 * client, which asks for "from here" and gets the bytes after it with no re-framing.
 */
export const byteCursorSchema = z
  .string()
  .regex(BYTE_CURSOR_PATTERN, 'must be b and a byte offset');

/** A cursor of either kind. Which kind a channel has is the channel's, and a client never builds one. */
export const cursorSchema = z.union([sequenceCursorSchema, byteCursorSchema]);

/** A channel's name: the id of the node it belongs to, or `tree` for the conversation's own. */
export const channelNameSchema = z.union([z.literal(TREE_CHANNEL_NAME), nodeIdSchema]);

/** What every entry of every channel has: where it is and when it was written. */
const entrySchema = z.object({ cursor: cursorSchema, at: timestampSchema });

/** Where a channel stood when something else was written: the link between two channels. */
const channelPositionSchema = z.object({ channel: channelNameSchema, cursor: cursorSchema });

/**
 * The first entry of a node's channel: the node as it was, and, for a node another started, where
 * the parent's channel stood at that moment, so a front end can place the child in the parent's
 * without a shared clock or counter. Its cursor is the start of the channel, of the kind the node's
 * kind allows.
 */
const nodeOpenedSchema = entrySchema
  .extend({
    channel: nodeIdSchema,
    type: z.literal('opened'),
    node: nodeInfoSchema,
    spawnedAt: channelPositionSchema.exactOptional(),
  })
  .refine(
    ({ channel, cursor, node, spawnedAt }) =>
      node.id === channel &&
      node.parent !== node.id &&
      cursorNumber(cursor) === 0 &&
      channelCursorKinds(node.kind).includes(cursorKind(cursor)) &&
      (node.parent === undefined ? spawnedAt === undefined : spawnedAt?.channel === node.parent),
    {
      error: 'an opened entry starts its own node, from the parent that spawned it',
      path: ['node'],
    },
  );

/**
 * The last entry of a node's channel: how the node ended. The outcome and the exit code are the
 * detail the state does not keep, and an outcome is one the state comes from.
 */
const nodeClosedSchema = entrySchema
  .extend({
    channel: nodeIdSchema,
    type: z.literal('closed'),
    state: z.enum(NODE_END_STATES),
    /** How an agent's last run ended. */
    outcome: runOutcomeSchema.exactOptional(),
    /** A command's or a service's exit code. */
    exitCode: z.number().int().nullable().exactOptional(),
    error: z.string().max(MAX_NODE_ERROR_CHARS).exactOptional(),
  })
  .refine(
    ({ state, outcome }) =>
      outcome === undefined || state === 'lost' || NODE_STATE_OF_OUTCOME[outcome] === state,
    { error: 'a closed entry has the state its outcome comes from', path: ['state'] },
  );

/**
 * A change to a live agent: the node as it is now. Only an agent's channel, which is numbered, has
 * them, between its `opened` entry and its `closed` one, so its cursor is never the first.
 */
const nodeUpdatedSchema = entrySchema
  .extend({
    channel: nodeIdSchema,
    type: z.literal('updated'),
    node: nodeInfoSchema,
  })
  .refine(
    ({ channel, cursor, node }) =>
      node.id === channel &&
      node.kind === 'agent' &&
      sequenceCursorSchema.safeParse(cursor).success &&
      cursorNumber(cursor) >= 1,
    { error: 'an updated entry is a live agent, numbered after its opened entry', path: ['node'] },
  );

/** The first entry of the tree channel: the conversation opened it. */
export const treeOpenedSchema = entrySchema
  .extend({ channel: z.literal(TREE_CHANNEL_NAME), type: z.literal('opened') })
  .refine(
    ({ cursor }) => sequenceCursorSchema.safeParse(cursor).success && cursorNumber(cursor) === 0,
    { error: 'the tree channel is numbered, from 0', path: ['cursor'] },
  );

/** The last entry of the tree channel: the conversation closed it. */
export const treeClosedSchema = entrySchema
  .extend({ channel: z.literal(TREE_CHANNEL_NAME), type: z.literal('closed') })
  .refine(({ cursor }) => sequenceCursorSchema.safeParse(cursor).success, {
    error: 'the tree channel is numbered',
    path: ['cursor'],
  });

/**
 * The two entries every channel starts and ends with, in their form for a node's channel and for
 * the tree channel. Each says what it holds; the other entries of a channel are the types the
 * issues that serve them add.
 */
export const channelBoundarySchema = z.union([
  nodeOpenedSchema,
  nodeClosedSchema,
  treeOpenedSchema,
  treeClosedSchema,
]);

/**
 * Every entry a channel holds today, and so every entry a subscription serves: the two boundary
 * entries and an agent's `updated`. A command's or a service's output is not an entry of its
 * channel (the complete output is the output store's), and the tree channel's other entries are
 * the tree's (`treeChannelEntrySchema`).
 */
export const channelEntrySchema = z.union([channelBoundarySchema, nodeUpdatedSchema]);

/**
 * One channel's entries, oldest first, checked for the shape of a channel (`isWellFormedChannelLog`):
 * it starts with `opened`, ends with `closed` once, keeps one cursor kind, has no gap in a sequence
 * and never goes back in bytes. Each entry is only checked for what every entry has; what an entry
 * of a given type holds is the schema of that type. It is not bounded: the array has no length cap
 * and an entry keeps any extra field (it is loose on purpose, so a type's own fields pass), so
 * whoever feeds it a log bounds the input; only a type name is capped.
 */
export const channelLogSchema = z
  .array(
    z.looseObject({
      cursor: cursorSchema,
      at: timestampSchema,
      channel: channelNameSchema,
      type: z.string().min(1).max(MAX_ENTRY_TYPE_CHARS),
    }),
  )
  .refine(isWellFormedChannelLog, { error: 'is not the entries of one well formed channel' });

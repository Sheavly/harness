import { z } from 'zod';
import { entryEventSchema } from '../event/event.validator.js';
import { callIdSchema, messageIdSchema } from '../message/message.validator.js';
import {
  CONVERSATION_CHANNEL_NAMES,
  MAX_NODE_ERROR_CHARS,
  MAX_NODE_REASON_CHARS,
  TREE_CHANNEL_NAME,
  USAGE_CHANNEL_NAME,
} from '../node/node.constants.js';
import { nodeIdSchema, nodeInfoSchema } from '../node/node.validator.js';
import { outputStatusSchema } from '../output/output.validator.js';
import { runOutcomeSchema } from '../session/session.validator.js';
import { MAX_QUEUED_LINE_CHARS } from '../server/server.constants.js';
import { NODE_END_STATES, NODE_STATE_OF_OUTCOME } from '../status/status.constants.js';
import { timestampSchema } from '../time/time.validator.js';
import {
  MAX_ENTRY_TYPE_CHARS,
  MAX_OMITTED_CALL_CHARS,
  MAX_OUTPUT_CHUNK_BYTES,
  RUN_START_CAUSES,
  TREE_ONLY_EVENT_TYPES,
} from './channel.constants.js';
import type { ConversationChannelName } from './channel.types.js';
import {
  channelCursorKinds,
  cursorKind,
  cursorNumber,
  isWellFormedChannelLog,
} from './channel.utils.js';
import {
  byteCursorSchema,
  cursorSchema,
  entrySchema,
  isAfterOpened,
  sequenceCursorSchema,
} from './cursor.validator.js';
import { nodeItemSchema } from './item-entry.validator.js';

/**
 * A channel's name: the id of the node it belongs to, or the name of one of the conversation's own
 * channels (`CONVERSATION_CHANNEL_NAMES`).
 */
export const channelNameSchema = z.union([z.enum(CONVERSATION_CHANNEL_NAMES), nodeIdSchema]);

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
    /**
     * The form the channel's entries are in, a positive whole number that a later form raises.
     * Absent means the earlier form, so a channel written before it existed reads as it always
     * did; a form is named only when it is not the earlier one.
     */
    format: z.number().int().positive().exactOptional(),
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
 * How a command's or a service's output ended, on its `closed` entry: `complete`, or `incomplete`
 * with what was lost (a limit, a failed write), so what was served is a prefix of the output and is
 * never presented as all of it. The log was closed before the node ended, so it is never still
 * `capturing`.
 */
const outputEndSchema = z
  .object({
    status: outputStatusSchema.exclude(['capturing']),
    /** Present exactly when `status` is `incomplete`. */
    reason: z.string().max(MAX_NODE_REASON_CHARS).exactOptional(),
  })
  .refine(({ status, reason }) => (status === 'incomplete') === (reason !== undefined), {
    error: 'reason is given exactly when the output is incomplete',
    path: ['reason'],
  });

/**
 * The last entry of a node's channel: how the node ended. The outcome and the exit code are the
 * detail the state does not keep, and an outcome is one the state comes from. A command's or a
 * service's, which counts bytes, also says how its output ended (`output`), and its cursor is where
 * the output stood: the bytes before it are all that was kept.
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
    /** How a command's or a service's output ended. */
    output: outputEndSchema.exactOptional(),
    error: z.string().max(MAX_NODE_ERROR_CHARS).exactOptional(),
  })
  .refine(
    ({ state, outcome }) =>
      outcome === undefined || state === 'lost' || NODE_STATE_OF_OUTCOME[outcome] === state,
    { error: 'a closed entry has the state its outcome comes from', path: ['state'] },
  )
  .refine(
    ({ cursor, output }) => output === undefined || byteCursorSchema.safeParse(cursor).success,
    {
      error: 'only a channel counted in bytes has an output to say how it ended',
      path: ['output'],
    },
  );

/** How many bytes `text` is as UTF-8: what a byte cursor counts. */
const utf8Bytes = (text: string) => new TextEncoder().encode(text).length;

/**
 * A part of the output of a command or a service: its text, and the byte offset of its first byte.
 * The entry's cursor is the offset after it, so a client that sends the last cursor it saw asks for
 * the bytes from there, and the next entry starts where this one ended. It is not stored in the
 * channel: a subscription makes it from the output store, which holds only text (the bytes are
 * always whole characters of UTF-8), so a chunk is a string and never cuts a character.
 */
const nodeOutputSchema = entrySchema
  .extend({
    channel: nodeIdSchema,
    type: z.literal('output'),
    /** The offset, in bytes, of `text`'s first byte in the output. */
    offset: z.number().int().nonnegative(),
    text: z.string().min(1).max(MAX_OUTPUT_CHUNK_BYTES),
  })
  .refine(
    ({ cursor, offset, text }) =>
      byteCursorSchema.safeParse(cursor).success &&
      cursorNumber(cursor) === offset + utf8Bytes(text) &&
      utf8Bytes(text) <= MAX_OUTPUT_CHUNK_BYTES &&
      text.isWellFormed(),
    {
      error:
        'an output entry is at most 16 KiB of UTF-8 text, and its cursor is the offset after it',
      path: ['cursor'],
    },
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

/**
 * A loop event of an agent, as its session's stream carried it: the event unchanged (it keeps its
 * own `seq`, which counts the session's events and is not the channel's cursor), with the
 * originating user message (`messageId`) where the stream's entry had one. The channel's own cursor
 * and `at` make it an entry of the channel. Every loop event but a conversation notice
 * (`TREE_ONLY_EVENT_TYPES`) is one.
 *
 * Adjacent `text_delta` events of one session may be stored as one entry: the event is the first's,
 * with the text of all of them in order, and `lastSeq` says the `seq` of the last one it holds, so a
 * reader that follows a session by `seq` still knows what it has. Only a text delta is merged.
 */
const nodeEventSchema = entrySchema
  .extend({
    channel: nodeIdSchema,
    type: z.literal('event'),
    event: entryEventSchema,
    messageId: messageIdSchema.exactOptional(),
    /** On a merged `text_delta`: the `seq` of the last delta in it, after the event's own. */
    lastSeq: z.number().int().nonnegative().exactOptional(),
  })
  .refine(({ cursor }) => isAfterOpened(cursor), {
    error: 'an event entry is numbered after the opened entry',
    path: ['cursor'],
  })
  .refine(({ event }) => !(TREE_ONLY_EVENT_TYPES as readonly string[]).includes(event.type), {
    error: 'a conversation notice is the tree channel’s, not an agent’s',
    path: ['event'],
  })
  .refine(
    ({ event, lastSeq }) =>
      lastSeq === undefined || (event.type === 'text_delta' && lastSeq > event.seq),
    {
      error: 'only a text delta is merged, and lastSeq comes after its own seq',
      path: ['lastSeq'],
    },
  );

/**
 * What an agent's channel holds in place of an event that is too large to store (a store keeps an
 * entry of `MAX_CHANNEL_ENTRY_CHARS` at most and refuses a longer one): that there was one, which,
 * where it stood in the session's stream, how large it was, as its JSON in characters, and, for an
 * event of one tool call (`tool_call_started`, `tool_result`, `task_running`), which call: its id and
 * tool name, so a reader that follows only this channel can still end that call's step. Its content
 * is not kept here; the combined stream still holds the whole event.
 */
const nodeEventOmittedSchema = entrySchema
  .extend({
    channel: nodeIdSchema,
    type: z.literal('event_omitted'),
    /** The omitted event's own type, a name a reader may not know. */
    eventType: z.string().min(1).max(MAX_ENTRY_TYPE_CHARS),
    /** The omitted event's own `seq`. */
    seq: z.number().int().nonnegative(),
    /** How large the event was: its JSON, in characters. */
    size: z.number().int().positive(),
    messageId: messageIdSchema.exactOptional(),
    /**
     * The omitted event's own call: the id of the tool call and its tool name, each at most
     * `MAX_OMITTED_CALL_CHARS`. Present when the event carried one call; an event of several
     * (`tool_batch`), of none, or whose call id was too long to name exactly has none.
     */
    call: z
      .object({
        id: callIdSchema.min(1).max(MAX_OMITTED_CALL_CHARS),
        name: z.string().max(MAX_OMITTED_CALL_CHARS),
      })
      .exactOptional(),
  })
  .refine(({ cursor }) => isAfterOpened(cursor), {
    error: 'an event_omitted entry is numbered after the opened entry',
    path: ['cursor'],
  });

/**
 * Where a run of an agent starts on its channel (the host writes it for the main agent's, which has
 * many runs): `run_started`, then the run's loop events, then its `done`, so a client that follows
 * only this channel knows where a run begins (a cursor of another channel orders nothing against
 * this one). `cause` says why it started, and `messageId` is the user
 * message the run answers; for a `wake`, the message of the prompt the run goes on from. `text` is
 * the user's prompt for a `prompt` (cut to a queued line's length, as the tree channel's
 * `prompt_started` is) and is absent for a `wake`, which has no prompt of its own.
 */
const runStartedSchema = entrySchema
  .extend({
    channel: nodeIdSchema,
    type: z.literal('run_started'),
    cause: z.enum(RUN_START_CAUSES),
    messageId: messageIdSchema,
    text: z.string().max(MAX_QUEUED_LINE_CHARS).exactOptional(),
  })
  .refine(({ cursor }) => isAfterOpened(cursor), {
    error: 'a run_started entry is numbered after the opened entry',
    path: ['cursor'],
  })
  .refine(({ cause, text }) => (cause === 'prompt') === (text !== undefined), {
    error: 'a prompt’s run says the prompt’s text, and a wake’s has none',
    path: ['text'],
  });

/** A conversation's own channel opens at position 0 of a numbered channel. */
const startsFromZero = ({ cursor }: { cursor: string }) =>
  sequenceCursorSchema.safeParse(cursor).success && cursorNumber(cursor) === 0;

/**
 * The entries a channel of the conversation itself starts and ends with: the conversation opened
 * it (numbered from 0), and closed it. One form for every channel of the family, each naming its
 * own channel, so an entry of one never reads as another's.
 */
function conversationBoundary<Name extends ConversationChannelName>(name: Name) {
  const opened = entrySchema
    .extend({ channel: z.literal(name), type: z.literal('opened') })
    .refine(startsFromZero, { error: `the ${name} channel is numbered, from 0`, path: ['cursor'] });
  const closed = entrySchema
    .extend({ channel: z.literal(name), type: z.literal('closed') })
    .refine(({ cursor }) => sequenceCursorSchema.safeParse(cursor).success, {
      error: `the ${name} channel is numbered`,
      path: ['cursor'],
    });

  return { opened, closed };
}

/** The first and last entries of the tree channel. */
export const { opened: treeOpenedSchema, closed: treeClosedSchema } =
  conversationBoundary(TREE_CHANNEL_NAME);

/** The last entry of the usage channel. */
export const { closed: usageClosedSchema } = conversationBoundary(USAGE_CHANNEL_NAME);

/**
 * The first entry of the usage channel. It says, with `earlierUncounted`, that the conversation had
 * already made model calls this channel did not count: it was kept before the channel existed, so
 * every figure on it is a lower bound. Left out when the channel counted from the conversation's
 * start.
 */
export const usageOpenedSchema = entrySchema
  .extend({
    channel: z.literal(USAGE_CHANNEL_NAME),
    type: z.literal('opened'),
    earlierUncounted: z.literal(true).exactOptional(),
  })
  .refine(startsFromZero, {
    error: `the ${USAGE_CHANNEL_NAME} channel is numbered, from 0`,
    path: ['cursor'],
  });

/**
 * The two entries every channel starts and ends with, in their form for a node's channel and for
 * each channel of the conversation itself. Each says what it holds; the other entries of a channel
 * are the types the issues that serve them add.
 */
export const channelBoundarySchema = z.union([
  nodeOpenedSchema,
  nodeClosedSchema,
  treeOpenedSchema,
  treeClosedSchema,
  usageOpenedSchema,
  usageClosedSchema,
]);

/**
 * Every entry of a node's channel a subscription serves: the two boundary entries, an agent's
 * `updated`, where each of its runs starts (`run_started`), its loop events (`event`, or
 * `event_omitted` for one too large to store), its completed items (`item`) and a
 * command's or a service's `output`. The output is not stored in the channel (the complete output
 * is the output store's): a subscription makes its entries between the stored `opened` and
 * `closed`. The tree channel's other entries are the tree's (`treeChannelEntrySchema`).
 */
export const channelEntrySchema = z.union([
  channelBoundarySchema,
  nodeUpdatedSchema,
  runStartedSchema,
  nodeEventSchema,
  nodeEventOmittedSchema,
  nodeItemSchema,
  nodeOutputSchema,
]);

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

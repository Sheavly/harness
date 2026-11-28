import { z } from 'zod';
import { MAX_OMITTED_CALL_CHARS } from '../channel/channel.constants.js';
import { toolArtifactSchema } from '../event/event.validator.js';
import { lowercaseUuidSchema } from '../id/id.validator.js';
import {
  callIdSchema,
  reasoningItemSchema,
  toolCallSchema,
  toolMessageSchema,
} from '../message/message.validator.js';
import { nodeIdSchema } from '../node/node.validator.js';
import { taskInfoSchema } from '../task/task.validator.js';
import { ITEM_REASONS, MAX_ITEM_DESCRIPTION_CHARS, MAX_ITEM_TEXT_CHARS } from './item.constants.js';

/**
 * An item's identity: a lowercase UUID made when the item starts, unique in the conversation and
 * never taken from a provider, whose ids repeat and have no bound. Branded, so it can't be passed
 * where another id goes.
 */
export const itemIdSchema = lowercaseUuidSchema.brand<'ItemId'>();

/**
 * Free text of a model, at most `MAX_ITEM_TEXT_CHARS` UTF-16 code units and never cut inside a
 * surrogate pair, so what a message holds can be sent in one entry. It is untrusted text: control
 * characters and escape sequences pass, and a reader that prints it escapes it.
 */
const itemTextSchema = z
  .string()
  .max(MAX_ITEM_TEXT_CHARS)
  // `max` counts code points, which is not the bound: a pair of units is one code point.
  .refine((text) => text.length <= MAX_ITEM_TEXT_CHARS, {
    error: `text is at most ${String(MAX_ITEM_TEXT_CHARS)} UTF-16 code units`,
  })
  .refine((text) => text.isWellFormed(), { error: 'text is not cut inside a surrogate pair' });

/** How large something was before an item left it out: its JSON, in characters. */
const omittedSizeSchema = z.number().int().positive();

/** How an item ended. */
const reasonSchema = z.enum(ITEM_REASONS);

/**
 * What a tool call's header holds, in the form both its item and its `item_started` carry. A
 * model's call may carry any length of each, so each is bounded here: the name and the call id
 * (`MAX_OMITTED_CALL_CHARS`, as an `event_omitted` entry's call is) and the description
 * (`MAX_ITEM_DESCRIPTION_CHARS`).
 */
const toolHeaderShape = {
  /** The provider's id of the call, a hint that joins the item to the history. Left out when longer than the bound, never cut. */
  callId: callIdSchema.min(1).max(MAX_OMITTED_CALL_CHARS).exactOptional(),
  name: z.string().max(MAX_OMITTED_CALL_CHARS),
  description: z.string().max(MAX_ITEM_DESCRIPTION_CHARS),
  /** The ordinal of the model call in the run that made it. */
  turn: z.number().int().nonnegative(),
};

/** What a tool returned, as a `tool_result` event carries it: the text the model reads, for a UI the artifacts, and how long it took. */
const toolResultSchema = toolMessageSchema.pick({ content: true, isError: true }).extend({
  artifacts: z.array(toolArtifactSchema).readonly().exactOptional(),
  durationMs: z.number(),
});

/** The background task a call launched, as a `task_running` event carries it: the task and the node it made. */
const launchedTaskSchema = z.object({
  info: taskInfoSchema,
  /** The node the call launched: its id in the tree, not the task's counter id. */
  nodeId: nodeIdSchema,
  durationMs: z.number(),
});

/** A reply's text: one run of the model's text, at most `MAX_ITEM_TEXT_CHARS` long. */
const messageItemSchema = z.object({
  kind: z.literal('message'),
  id: itemIdSchema,
  text: itemTextSchema,
  reason: reasonSchema,
});

/**
 * The model's reasoning, with the opaque state it needs resent (`item`). When that state was too
 * large to keep, `item` is left out and `omitted` says its size.
 */
const reasoningItemEntrySchema = z
  .object({
    kind: z.literal('reasoning'),
    id: itemIdSchema,
    item: reasoningItemSchema.exactOptional(),
    omitted: omittedSizeSchema.exactOptional(),
    reason: reasonSchema,
  })
  .refine(({ item, omitted }) => item === undefined || omitted === undefined, {
    error: 'reasoning that was left out has no state, and state that is there was not left out',
    path: ['omitted'],
  });

/**
 * A tool call and what became of it, in one item. A call that launched a node has a `task` and no
 * `result`; any other has a `result`, which for a call stopped before its tool settled
 * (`interrupted` or `failed`) is the placeholder the history holds for it, and `reason` says which
 * stop. What was too large to keep is left out and `omitted` says its size: the call's `input`,
 * or its `result`.
 */
const toolCallItemSchema = z
  .object({
    kind: z.literal('tool_call'),
    id: itemIdSchema,
    ...toolHeaderShape,
    /** The call's input, as a tool call types it. Left out, with `omitted.input`, when it was too large to keep. */
    input: toolCallSchema.shape.input.exactOptional(),
    result: toolResultSchema.exactOptional(),
    task: launchedTaskSchema.exactOptional(),
    omitted: z
      .object({
        input: omittedSizeSchema.exactOptional(),
        result: omittedSizeSchema.exactOptional(),
      })
      .exactOptional(),
    reason: reasonSchema,
  })
  .refine(({ result, task }) => result === undefined || task === undefined, {
    error: 'a call that launched a task has no result of its own',
    path: ['task'],
  })
  .refine(
    ({ input, result, omitted }) =>
      (input === undefined || omitted?.input === undefined) &&
      (result === undefined || omitted?.result === undefined),
    {
      error: 'what an item says it left out is not in it',
      path: ['omitted'],
    },
  );

/**
 * One completed item of an agent's channel: a reply's text, the model's reasoning, or a tool call
 * with its result. It says how it ended (`reason`): a message cut by a stop keeps its partial text.
 */
export const itemSchema = z.discriminatedUnion('kind', [
  messageItemSchema,
  reasoningItemEntrySchema,
  toolCallItemSchema,
]);

/**
 * An item has started. For a tool call it carries the header (`toolHeaderShape`), never its input:
 * the live form of an item holds only what is bounded.
 */
export const itemStartedEventSchema = z.discriminatedUnion('kind', [
  z.object({
    type: z.literal('item_started'),
    itemId: itemIdSchema,
    kind: z.literal('message'),
  }),
  z.object({
    type: z.literal('item_started'),
    itemId: itemIdSchema,
    kind: z.literal('reasoning'),
  }),
  z.object({
    type: z.literal('item_started'),
    itemId: itemIdSchema,
    kind: z.literal('tool_call'),
    ...toolHeaderShape,
  }),
]);

/**
 * A message's text grew by `text`. `offset` is the UTF-16 code units of the item's text before this
 * delta, so a reader that was told part of the text takes only what it lacks. A message holds at
 * most `MAX_ITEM_TEXT_CHARS`, so the delta ends inside that.
 */
export const itemDeltaEventSchema = z
  .object({
    type: z.literal('item_delta'),
    itemId: itemIdSchema,
    offset: z.number().int().nonnegative().max(MAX_ITEM_TEXT_CHARS),
    text: itemTextSchema,
  })
  .refine(({ offset, text }) => offset + text.length <= MAX_ITEM_TEXT_CHARS, {
    error: 'a delta ends inside what a message may hold',
    path: ['text'],
  });

/** An item completed, as the channel stores it. */
const itemCompletedEventSchema = z.object({ type: z.literal('item_completed'), item: itemSchema });

/**
 * What an agent's items say as they happen. A union of its own, not a member of the loop's events
 * (`entryEventSchema`) or of the combined stream's entries: no reader of those sees an item.
 */
export const itemEventSchema = z.union([
  itemStartedEventSchema,
  itemDeltaEventSchema,
  itemCompletedEventSchema,
]);

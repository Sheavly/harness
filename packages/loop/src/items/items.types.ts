import type { Item, ItemEvent, ItemId } from '@sheavly/protocol/item/item.types';
import type { DescribedCall } from '@sheavly/protocol/event/event.types';
import type { ToolMessage } from '@sheavly/protocol/message/message.types';
import type { ToolOutcome } from '../events/events.types.js';

/** How an item ended: `completed`, `interrupted` or `failed`. */
export type ItemReason = Item['reason'];

/** Where the items of a reply are told, as they happen and in the order the loop made them. */
export type PublishItem = (event: ItemEvent) => void;

/** What a tool's completed item is made from, once the tool has settled. */
export type ToolItemSource = {
  id: ItemId;
  described: DescribedCall;
  /** The ordinal of the model call, in the run, that made the call. */
  turn: number;
  /** What the loop released for the call: its result, or the task it launched. */
  outcome: ToolOutcome;
  /** The message of `outcome`, as history holds it (the placeholder for a call that was stopped). */
  message: ToolMessage;
  reason: ItemReason;
};

/** The message the reply is making: the text it holds so far, all well-formed. */
export type OpenMessage = { id: ItemId; text: string };

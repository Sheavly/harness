import { randomUUID } from 'node:crypto';
import { MAX_ITEM_TEXT_CHARS } from '@sheavly/protocol/item/item.constants';
import type { ItemId } from '@sheavly/protocol/item/item.types';
import { itemIdSchema } from '@sheavly/protocol/item/item.validator';
import type { ReasoningItem, ToolCall } from '@sheavly/protocol/message/message.types';
import type { ItemReason, OpenMessage, PublishItem, ToolItemSource } from './items.types.js';
import { completedTool, holdBack, splitForRoom, toolStarted } from './items.utils.js';

/**
 * Makes the items of ONE model call from the chunks the model streams, in the order they come,
 * and tells each as it happens through `publish`. The loop sees every chunk, so no adapter has to
 * mark where an item starts or ends:
 *
 * - a message starts with the first text, and completes when a reasoning or tool call chunk
 *   follows it, at `MAX_ITEM_TEXT_CHARS` (the next text then starts another message), or at
 *   `finish`;
 * - reasoning arrives whole, and is complete when it starts;
 * - a tool call starts when it arrives and completes when its tool settles (`completeTool`).
 *
 * A text delta never holds half of a surrogate pair: a final high unit is held back until the next
 * chunk, and one still alone when the message completes is replaced, as `toWellFormed` does.
 */
export class ReplyItems {
  readonly #publish: PublishItem;
  readonly #turn: number;
  #message: OpenMessage | undefined;
  /** A high surrogate that ended the last chunk, waiting for the chunk that may finish its pair. */
  #held = '';

  /** `turn` is the ordinal of the model call in the run, which a tool call's item carries. */
  constructor(params: { publish: PublishItem; turn: number }) {
    this.#publish = params.publish;
    this.#turn = params.turn;
  }

  /** The model streamed `chunk` of its reply's text. */
  text(chunk: string): void {
    const { ready, held } = holdBack(this.#held + chunk);

    this.#held = held;
    this.#append(ready);
  }

  /** The model's reasoning arrived, whole. */
  reasoning(item: ReasoningItem): void {
    this.#closeMessage('completed');

    const id = mintItemId();

    this.#publish({ type: 'item_started', itemId: id, kind: 'reasoning' });
    this.#publish({
      type: 'item_completed',
      item: { kind: 'reasoning', id, item, reason: 'completed' },
    });
  }

  /** The model called a tool, which starts now. Returns the id its item completes under. */
  toolCall(params: { call: ToolCall; description: string }): ItemId {
    this.#closeMessage('completed');

    const id = mintItemId();

    this.#publish(toolStarted({ id, ...params, turn: this.#turn }));

    return id;
  }

  /**
   * The tool of item `id` settled, or was stopped before it did: completes the item with `reason`
   * and what the loop made of the call. It may come after `finish`, when the tool outlived the reply.
   */
  completeTool(source: Omit<ToolItemSource, 'turn'>): void {
    this.#publish({
      type: 'item_completed',
      item: completedTool({ ...source, turn: this.#turn }),
    });
  }

  /** The model call is over: completes the open message, if any, with how the call ended. */
  finish(params: { reason: ItemReason }): void {
    this.#closeMessage(params.reason);
  }

  /** Adds well-formed-or-broken `text` to the open message, splitting at the cap. */
  #append(text: string): void {
    let rest = text;

    while (rest !== '') {
      const open = this.#openMessage();
      const room = MAX_ITEM_TEXT_CHARS - open.text.length;
      const { head, rest: tail } = splitForRoom({ text: rest, room });
      // A lone unit inside a chunk is replaced by one unit, so every offset still adds up.
      const delta = head.toWellFormed();

      if (delta !== '') {
        this.#publish({
          type: 'item_delta',
          itemId: open.id,
          offset: open.text.length,
          text: delta,
        });
        open.text += delta;
      }

      rest = tail;

      if (rest !== '') this.#completeMessage('completed');
    }
  }

  #openMessage(): OpenMessage {
    if (this.#message) return this.#message;

    this.#message = { id: mintItemId(), text: '' };
    this.#publish({ type: 'item_started', itemId: this.#message.id, kind: 'message' });

    return this.#message;
  }

  /** Lets go of a held unit that no chunk will complete, then completes the open message. */
  #closeMessage(reason: ItemReason): void {
    const lone = this.#held;

    this.#held = '';
    this.#append(lone);
    this.#completeMessage(reason);
  }

  #completeMessage(reason: ItemReason): void {
    const open = this.#message;

    if (!open) return;

    this.#message = undefined;
    this.#publish({
      type: 'item_completed',
      item: { kind: 'message', id: open.id, text: open.text, reason },
    });
  }
}

/** A new item's identity: a lowercase UUID, never a provider's id. */
function mintItemId(): ItemId {
  return itemIdSchema.parse(randomUUID());
}

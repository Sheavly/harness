import type { MessageId } from '@sheavly/protocol/message/message.types';
import { MAX_RESOLVED_IDS } from './chat.constants.js';

/**
 * The lines the backend accepted from this chat that have not come to their end, by message id:
 * a line is owed from the moment the backend answers it, and is paid by its run's end, by a
 * refusal, or by a client's edit of the queue that took it out. A notice can come before the
 * answer that names its id, so the ids of the last notices are remembered, and a line whose notice
 * has come is not owed when its answer arrives.
 */
export class OwedMessages {
  readonly #owed = new Set<MessageId>();
  /** The ids settled, oldest first, which no line was owed for yet. */
  readonly #settled: MessageId[] = [];

  /** Whether nothing is owed. */
  get none(): boolean {
    return this.#owed.size === 0;
  }

  /** The backend accepted the line `id`: it is owed, unless its notice has come. */
  owe(id: MessageId): void {
    if (this.#settled.includes(id)) return;
    this.#owed.add(id);
  }

  /** The line `id` came to its end, whether or not the backend's answer has come. */
  settle(id: MessageId): void {
    if (this.#owed.delete(id)) return;
    this.#settled.push(id);
    if (this.#settled.length > MAX_RESOLVED_IDS) this.#settled.shift();
  }

  /** Nothing more can be heard, so nothing is owed. */
  clear(): void {
    this.#owed.clear();
  }
}

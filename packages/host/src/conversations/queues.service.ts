import type { ConversationStore } from '@sheavly/core/store/store.types';
import { parseOrThrow } from '@sheavly/core/validation/validation.validator';
import type { ConversationId } from '@sheavly/protocol/server/server.types';
import { queuedPromptsSchema } from '@sheavly/protocol/server/server.validator';
import { ConversationsError } from '../errors/conversations.errors.js';

/**
 * Where each conversation's waiting lines are kept: pending input outside history, model input and
 * summaries. With a store they survive a restart (`queue.json`); without one they last as long as
 * the process. Reading starts nothing: the conversation's `PromptQueue` decides when a line becomes
 * a prompt, and a reopen parks what it reads.
 */
export class ConversationQueues {
  readonly #store: ConversationStore | undefined;
  /** What a host that keeps nothing holds. */
  readonly #unkept = new Map<ConversationId, string[]>();

  constructor(params: { store: ConversationStore | undefined }) {
    this.#store = params.store;
  }

  /**
   * The lines queued in conversation `id`, oldest first. Rejects with a `StoreError` when storage
   * fails, and `storage_failed` for a stored document that is not a list of lines.
   */
  async read(id: ConversationId): Promise<string[]> {
    if (!this.#store) return [...(this.#unkept.get(id) ?? [])];

    const stored: unknown = await this.#store.queue(id).load();

    if (stored === undefined) return [];

    return parseOrThrow({
      schema: queuedPromptsSchema,
      input: stored,
      onInvalid: ({ error }) =>
        new ConversationsError({
          reason: 'storage_failed',
          message: `The queue stored for conversation ${id} is not a list of lines`,
          cause: error,
        }),
    }).queued;
  }

  /** Replaces conversation `id`'s queued lines, whole. */
  async replace(params: { id: ConversationId; queued: readonly string[] }): Promise<void> {
    const { id, queued } = params;

    if (!this.#store) {
      this.#unkept.set(id, [...queued]);

      return;
    }

    await this.#store.queue(id).update(() => ({ queued: [...queued] }));
  }
}

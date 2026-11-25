import type { ConversationStore } from '@sheavly/core/store/store.types';
import type { AgentEvent } from '@sheavly/protocol/event/event.types';
import type { MessageId } from '@sheavly/protocol/message/message.types';
import type { PromptSent } from '@sheavly/protocol/node-command/node-command.types';
import type { ConversationId, SendPromptRequest } from '@sheavly/protocol/server/server.types';
import { ConversationsError } from '../errors/conversations.errors.js';
import type { LiveConversation, PromptFailure, SentPrompt } from './conversations.types.js';
import { partsText } from '@sheavly/protocol/message/message.utils';
import { prepareForSend, refuseOverlappingSend, releaseOnAbort } from './prompt.helper.js';
import { PromptQueue } from './prompt-queue.service.js';
import { publishQueueUpdate } from './queue-notices.helper.js';
import { ConversationQueues } from './queues.service.js';
import { announceStorageFailure } from './storage.helper.js';

/** How a conversation's storage is checked before a prompt: `Conversations` owns the keepers. */
type StorageChecks = {
  /** Whether a write of conversation `id` has failed. */
  failed: (id: ConversationId) => boolean;
  /** Tries the failed writes again. */
  recover: (id: ConversationId) => Promise<void>;
  /** Throws `storage_failed` when the conversation can no longer be kept. */
  assertHealthy: (id: ConversationId) => void;
};

/** What a send is given; `onStarted` is told once the prompt runs, before its run's events. */
type SendParams = {
  id: ConversationId;
  live: LiveConversation;
  prompt: SendPromptRequest;
  signal?: AbortSignal | undefined;
  onStarted?: (() => void) | undefined;
};

/**
 * What comes into each live conversation: the prompt being prepared and its stop switch, and the
 * lines waiting in its queue (`PromptQueue`, kept by `ConversationQueues`). A conversation is free
 * when nothing runs in it and no prompt is being prepared: `submit` starts a prompt then, and
 * queues it otherwise. A prompt `submit` or the queue starts is read here, so it runs whoever
 * follows the stream.
 */
export class ConversationInputs {
  readonly #queues: ConversationQueues;
  readonly #lines = new Map<ConversationId, PromptQueue>();
  /** The writes a closed conversation's queue had not finished, which its reopen waits for. */
  readonly #closing = new Map<ConversationId, Promise<void>>();
  /** A prompt still being prepared (its skills), until it starts or fails. */
  readonly #preparing = new Map<ConversationId, Promise<void>>();
  /** Each conversation's running prompt's stop switch. */
  readonly #running = new Map<ConversationId, AbortController>();
  readonly #storage: StorageChecks;
  readonly #onPromptFailure: ((failure: PromptFailure) => void) | undefined;

  constructor(params: {
    store: ConversationStore | undefined;
    storage: StorageChecks;
    onPromptFailure?: ((failure: PromptFailure) => void) | undefined;
  }) {
    this.#queues = new ConversationQueues({ store: params.store });
    this.#storage = params.storage;
    this.#onPromptFailure = params.onPromptFailure;
  }

  /**
   * The lines kept for conversation `id`, for a reopen to read before it goes live: read once the
   * queue it had before its close has finished writing, so a late write cannot overwrite the next.
   */
  async stored(id: ConversationId): Promise<string[]> {
    await this.#closing.get(id);
    this.#closing.delete(id);

    return this.#queues.read(id);
  }

  /** Gives conversation `id`, now live as `live`, its queue: `restored` lines wait, parked. */
  open(params: { id: ConversationId; live: LiveConversation; restored: readonly string[] }): void {
    const { id, live, restored } = params;
    const queue: PromptQueue = new PromptQueue({
      restored,
      conversation: live.conversation,
      preparing: () => this.#preparing.get(id),
      start: async ({ text, taken }) => {
        await this.#startLine({ id, live, prompt: { text }, left: taken });
      },
      publish: (update) => publishQueueUpdate({ live, update }),
      keep: (lines) => this.#queues.replace({ id, queued: lines }),
      onStoreFailure: (failure) => announceStorageFailure({ live, failure }),
      onStartFailure: (error) => this.#onPromptFailure?.({ id, error }),
      // Closed, or closed and reopened: either way this queue starts nothing more.
      closed: () => this.#lines.get(id) !== queue,
    });

    this.#lines.set(id, queue);
  }

  /** Stops conversation `id`'s prompt as it closes, and forgets its queue: its lines stay stored. */
  close(id: ConversationId): void {
    const queue = this.#lines.get(id);

    if (queue) this.#closing.set(id, queue.settled());
    this.#lines.delete(id);
    this.stop(id);
  }

  /** Stops the prompt conversation `id` prepares or runs, if any. */
  stop(id: ConversationId): void {
    this.#running.get(id)?.abort();
  }

  /** See `Conversations.send`. */
  send(params: Omit<SendParams, 'onStarted'>): Promise<SentPrompt> {
    return this.#send(params);
  }

  /** See `Conversations.submit`. */
  async submit(params: {
    id: ConversationId;
    live: LiveConversation;
    prompt: SendPromptRequest;
  }): Promise<PromptSent> {
    const { id, live, prompt } = params;
    const queue = this.#queueOf(id);
    const { harness } = live;
    // The agent whose channel carries the run: the main agent's, which every prompt runs on.
    const node = harness.sessions.nodeIdOf(harness.mainSession.id);

    if (node === undefined) {
      throw new ConversationsError({
        reason: 'not_found',
        message: `Conversation ${id} has no main agent node: it was closed`,
      });
    }

    if (live.conversation.state === 'idle' && !this.#preparing.has(id) && !queue.busy) {
      // Lines sent while this one prepared its skills wait behind it: the answer says so.
      const messageId = await this.#startLine({ id, live, prompt, left: () => queue.lines });

      return { status: 'started', node, messageId, queued: queue.lines };
    }

    if (!('text' in prompt)) {
      throw new ConversationsError({
        reason: 'cannot_queue',
        message:
          'A prompt that picks skills cannot wait in the queue, and something runs or waits ahead of it: send it as text, or once nothing does',
      });
    }

    this.#storage.assertHealthy(id);

    return { status: 'queued', node, queued: await queue.add(prompt.text) };
  }

  /** The lines waiting in conversation `id`, oldest first. */
  lines(id: ConversationId): string[] {
    return this.#queueOf(id).lines;
  }

  /** Replaces conversation `id`'s waiting lines, whole: they start in their new order. */
  replace(params: { id: ConversationId; queued: readonly string[] }): Promise<void> {
    return this.#queueOf(params.id).replace(params.queued);
  }

  #queueOf(id: ConversationId): PromptQueue {
    const queue = this.#lines.get(id);

    if (!queue) {
      throw new ConversationsError({
        reason: 'not_found',
        message: `No conversation ${id}: it was closed, or never started`,
      });
    }

    return queue;
  }

  /**
   * Marks the prompt as being prepared from before its first await, so a `submit` meanwhile finds
   * the conversation busy, and refuses a second at once: it must not take over the stop switch.
   */
  async #send(params: SendParams): Promise<SentPrompt> {
    const { id, live } = params;

    if (this.#preparing.has(id)) refuseOverlappingSend(live.harness.mainSession.id);

    const settled = Promise.withResolvers<undefined>();

    this.#preparing.set(id, settled.promise);
    // Work finishing while skills are prepared must not start a wake the prompt then waits for:
    // the prompt delivers it.
    live.conversation.deferWakes(true);

    try {
      return await this.#prepareAndStart(params);
    } finally {
      this.#preparing.delete(id);
      settled.resolve(undefined);
      this.#lines.get(id)?.syncWakes();
    }
  }

  async #prepareAndStart(params: SendParams): Promise<SentPrompt> {
    const { id, live, prompt, signal, onStarted } = params;
    const { conversation, skills } = live;

    // Awaited only after a failure: an await on a healthy conversation would open a gap before
    // the stop switch below is registered, and a stop arriving in it would be missed.
    if (this.#storage.failed(id)) await this.#storage.recover(id);

    this.#storage.assertHealthy(id);

    // A prompt that runs keeps its stop switch until it ends; a wake is settled below instead.
    if (conversation.state === 'prompt') refuseOverlappingSend(live.harness.mainSession.id);

    // Registered before preparing so a stop that arrives meanwhile reaches this prompt; it then
    // starts already aborted and ends as interrupted.
    const stop = new AbortController();
    const stopSignal = signal ? AbortSignal.any([signal, stop.signal]) : stop.signal;

    this.#running.set(id, stop);
    // Cleared on a stop too: a caller that never reads the events would leave it for good.
    const release = releaseOnAbort({ signal: stopSignal, switches: this.#running, id, stop });

    // Nothing iterates `events` when a step throws, so the switch is released here.
    const { prepared, events } = await prepareForSend({
      prompt,
      skills,
      signal: stopSignal,
      assertHealthy: () => this.#storage.assertHealthy(id),
      settleWake: () => conversation.settleWake(),
      start: (prepared) => {
        // The run's events come only once they are read, so this is told before any of them.
        const started = conversation.send(prepared.text, {
          signal: stopSignal,
          parts: prepared.parts,
        });

        onStarted?.();

        return started;
      },
      onFailure: release,
    });

    return {
      events: untilDone({ release, events }),
      text: prepared.text,
      ...(prepared.parts && { parts: prepared.parts }),
    };
  }

  /**
   * Starts `prompt` as the next prompt, says so on the stream (`prompt_started`, with the lines
   * `left` behind it as it starts, read then), and reads its run: nobody else does. Returns the
   * user message the prompt became, which the main session has as the prompt starts.
   */
  async #startLine(params: {
    id: ConversationId;
    live: LiveConversation;
    prompt: SendPromptRequest;
    left: () => readonly string[];
  }): Promise<MessageId> {
    const { id, live, prompt, left } = params;
    const text = 'text' in prompt ? prompt.text : partsText(prompt.parts);
    let messageId: MessageId | undefined;
    const { events } = await this.#send({
      ...params,
      onStarted: () => {
        messageId = live.harness.sessions.messageOf(live.harness.mainSession.id);
        publishQueueUpdate({
          live,
          update: { type: 'prompt_started', text, queued: [...left()] },
        });
      },
    });

    void this.#readToEnd({ id, events });

    // `send` starts the prompt, and `onStarted` runs after it: the message exists by then.
    if (messageId === undefined) {
      throw new ConversationsError({
        reason: 'not_found',
        message: `Conversation ${id} did not start the prompt: it was closed`,
      });
    }

    return messageId;
  }

  /** Reads a run nobody else reads; a failed one is on the stream already, and the app logs it. */
  async #readToEnd(params: {
    id: ConversationId;
    events: AsyncIterable<AgentEvent>;
  }): Promise<void> {
    try {
      for await (const _event of params.events);
    } catch (caughtError) {
      // Nothing awaits this run: rethrowing would be an unhandled rejection that stops the host.
      this.#onPromptFailure?.({ id: params.id, error: caughtError });
    }
  }
}

/** The prompt's events, forgetting its stop switch once it ends, however it ends. */
async function* untilDone(params: { release: () => void; events: AsyncIterable<AgentEvent> }) {
  try {
    yield* params.events;
  } finally {
    params.release();
  }
}

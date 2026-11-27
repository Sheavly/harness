import { StoreError } from '@sheavly/core/errors/store.errors';
import type { MessageId } from '@sheavly/protocol/message/message.types';
import type { QueueUpdate } from '@sheavly/protocol/queue/queue.types';
import { queuedPromptsSchema } from '@sheavly/protocol/server/server.validator';
import { SessionError } from '@sheavly/runtime/errors/sessions.errors';
import type { Conversation } from '../conversation/conversation.types.js';
import { mintMessageId } from '../conversation/message-id.helper.js';
import { ConversationsError } from '../errors/conversations.errors.js';
import type { QueuedLine } from './conversations.types.js';
import { replaceLines, withoutLine } from './queued-lines.utils.js';

/**
 * The lines waiting in one live conversation, oldest first, and the one runner that starts each
 * as the next prompt once nothing runs: a run going now is asked to end at its completion point
 * and waited for, and a run held on `await_tasks` ignores that until its grouped work has settled
 * and the model has finished (flow rules 3 and 4). Every change goes on the stream (`publish`) and
 * to the store (`keep`), so the lines survive a restart.
 *
 * Lines a reopen restored are parked: they wait, but none starts until the user sends the next
 * line, since reopening never runs them; so are lines a client puts while none waits on a run. A
 * line leaves the queue only once it has started, so a close or a crash before that keeps it. A
 * stop leaves the lines, which start after the stopped run; a stop that reaches a line still
 * preparing its skills keeps it, parked. A closed conversation starts none. A line that cannot
 * start is reported (`prompt_refused`) and dropped, so the ones behind it still run.
 *
 * Each line has the message id it was accepted with, which its run's user message has when it
 * starts, and which every update about it carries (`prompt_started`, `prompt_refused`, and
 * `dropped` on `queue_changed` for a line a client's edit left out). The ids are in memory only:
 * lines a reopen restores get new ones.
 */
export class PromptQueue {
  #lines: QueuedLine[];
  #parked: boolean;
  #draining = false;
  /** The line the runner is starting: it stays in the queue until it has started. */
  #starting: MessageId | undefined;
  readonly #conversation: Pick<Conversation, 'state' | 'yieldPrompt' | 'whenIdle' | 'deferWakes'>;
  readonly #preparing: () => Promise<void> | undefined;
  readonly #start: (params: {
    text: string;
    messageId: MessageId;
    taken: () => readonly string[];
  }) => Promise<void>;
  /** The writes of the lines not yet done, which a reopen waits for. */
  readonly #writes = new Set<Promise<void>>();
  readonly #publish: (update: QueueUpdate) => void;
  readonly #keep: (lines: readonly string[]) => Promise<void>;
  readonly #onStoreFailure: (failure: StoreError) => void;
  readonly #onStartFailure: (error: unknown) => void;
  readonly #closed: () => boolean;

  constructor(params: {
    /** What a reopen restored, parked; none for a new conversation. */
    restored: readonly string[];
    conversation: Pick<Conversation, 'state' | 'yieldPrompt' | 'whenIdle' | 'deferWakes'>;
    /** Settles when a prompt sent outside the queue has started or failed; none when none prepares. */
    preparing: () => Promise<void> | undefined;
    /**
     * Starts `text` as the next prompt, with `messageId` as its user message's id; rejects when it
     * can't. It calls `taken` as the prompt starts, which takes the line out of the queue and
     * returns the lines left behind it.
     */
    start: (params: {
      text: string;
      messageId: MessageId;
      taken: () => readonly string[];
    }) => Promise<void>;
    publish: (update: QueueUpdate) => void;
    keep: (lines: readonly string[]) => Promise<void>;
    onStoreFailure: (failure: StoreError) => void;
    /** Hears why a line could not start when it is not a refusal the user can act on. */
    onStartFailure: (error: unknown) => void;
    /** Whether the conversation is gone: nothing starts after that. */
    closed: () => boolean;
  }) {
    this.#lines = params.restored.map((text) => ({ text, messageId: mintMessageId() }));
    this.#parked = this.#lines.length > 0;
    this.#conversation = params.conversation;
    this.#preparing = params.preparing;
    this.#start = params.start;
    this.#publish = params.publish;
    this.#keep = params.keep;
    this.#onStoreFailure = params.onStoreFailure;
    this.#onStartFailure = params.onStartFailure;
    this.#closed = params.closed;
  }

  /** The lines waiting now, oldest first. */
  get lines(): string[] {
    return this.#lines.map(({ text }) => text);
  }

  /** Resolves once the writes of the lines begun so far are done: a reopen reads the file after. */
  async settled(): Promise<void> {
    await Promise.all(this.#writes);
  }

  /**
   * Lines wait, or the runner is starting one: a prompt sent now must queue behind them, never
   * start ahead.
   */
  get busy(): boolean {
    return this.#draining || this.#lines.length > 0;
  }

  /**
   * Holds wakes back while lines may start or a prompt is being prepared: either delivers what
   * finished. Called as either changes.
   */
  syncWakes(): void {
    this.#conversation.deferWakes(this.#waiting || this.#preparing() !== undefined);
  }

  /**
   * Puts `line` behind the waiting ones, gives it its message id, releases parked ones, and starts
   * the runner. Returns the lines after it and the line's id. Throws `cannot_queue`, changing
   * nothing, for a line longer than a queued line may be or a full queue.
   */
  async add(line: string): Promise<{ queued: string[]; messageId: MessageId }> {
    const added = { text: line, messageId: mintMessageId() };
    const lines = [...this.#lines, added];

    if (!queuedPromptsSchema.safeParse({ queued: lines.map(({ text }) => text) }).success) {
      throw new ConversationsError({
        reason: 'cannot_queue',
        message: 'This line cannot wait in the queue: it is too long for it, or the queue is full',
      });
    }

    this.#parked = false;
    await this.#change({ lines, dropped: [] });
    this.#run();

    return { queued: this.lines, messageId: added.messageId };
  }

  /**
   * Replaces the waiting lines whole, as a client edited them. A line that is still there keeps
   * its id, a new one gets one, and the ids of the lines left out go out as `dropped`. Lines
   * waiting behind a run keep waiting for it; put while none waits, they are parked: an edit never
   * starts a prompt itself, only the next line sent does.
   */
  async replace(texts: readonly string[]): Promise<void> {
    if (!this.#draining) this.#parked = texts.length > 0;

    const { lines, dropped } = replaceLines({
      current: this.#lines,
      texts,
      mint: mintMessageId,
    });

    // The line being started goes on starting whatever the edit says, so it is not dropped.
    await this.#change({ lines, dropped: dropped.filter((id) => id !== this.#starting) });
    this.#run();
  }

  /** Lines wait that may start: some, and not parked. */
  get #waiting(): boolean {
    return this.#lines.length > 0 && !this.#parked;
  }

  async #change(params: { lines: QueuedLine[]; dropped: readonly MessageId[] }): Promise<void> {
    const { lines, dropped } = params;
    const same =
      lines.length === this.#lines.length &&
      lines.every(({ messageId }, i) => messageId === this.#lines[i]?.messageId);

    this.#lines = lines;
    this.syncWakes();
    // A client that puts the same lines again changes nothing on the stream or on disk.
    if (same && dropped.length === 0) return;
    this.#publish({
      type: 'queue_changed',
      queued: this.lines,
      ...(dropped.length > 0 && { dropped: [...dropped] }),
    });
    await this.#store();
  }

  /** Writes the lines; a failed write is announced, and the lines in memory still run. */
  async #store(): Promise<void> {
    const write = this.#write();

    this.#writes.add(write);

    try {
      await write;
    } finally {
      this.#writes.delete(write);
    }
  }

  async #write(): Promise<void> {
    try {
      await this.#keep(this.lines);
    } catch (caughtError) {
      // Only a store failure is expected: the conversation says so on its stream and goes on.
      if (!(caughtError instanceof StoreError)) throw caughtError;
      this.#onStoreFailure(caughtError);
    }
  }

  /** Starts the runner unless it runs, nothing may start, or the conversation is gone. */
  #run(): void {
    if (this.#draining || !this.#waiting || this.#closed()) return;
    this.#draining = true;
    // Nothing awaits the runner: a throw out of it would be an unhandled rejection that stops the
    // host. A line added just as it finished would otherwise wait for the next one.
    void this.#drain()
      .catch((caughtError: unknown) => this.#onStartFailure(caughtError))
      .finally(() => {
        this.#draining = false;
        this.#run();
      });
  }

  async #drain(): Promise<void> {
    while (this.#waiting && !this.#closed()) {
      await this.#untilFree();

      // Read after waiting: a client may have replaced the lines meanwhile.
      const [line] = this.#lines;

      if (line === undefined || !this.#waiting || this.#closed()) return;

      // The line stays in the queue until it has started, so a close or a stop before that keeps it.
      if ((await this.#startOrRefuse(line)) === 'kept') {
        this.#parked = !this.#closed();
        this.syncWakes();

        return;
      }

      // A closed queue writes nothing more: a reopen may already own the file.
      if (!this.#closed()) await this.#store();
      // Wakes stayed deferred until the line started, so none could take its place meanwhile.
      this.syncWakes();
    }
  }

  /**
   * Starts `line` with its own message id, or reports why it can't; `kept` when a close, or a stop
   * reaching the line while its skills were prepared, came before it started: it stays in the queue.
   */
  async #startOrRefuse(line: QueuedLine): Promise<'started' | 'refused' | 'kept'> {
    const { text, messageId } = line;
    let taken = false;
    const take = () => {
      taken = true;
      this.#take(messageId);

      return this.lines;
    };

    this.#starting = messageId;

    try {
      await this.#start({ text, messageId, taken: take });

      return 'started';
    } catch (caughtError) {
      const stopped = caughtError instanceof Error && caughtError.name === 'AbortError';

      if (!taken && (this.#closed() || stopped)) {
        this.#reportVanished(messageId);

        return 'kept';
      }

      if (!taken) this.#take(messageId);
      this.#refuse({ line, caughtError });

      return 'refused';
    } finally {
      this.#starting = undefined;
    }
  }

  /** Takes the line with `messageId` out of the waiting lines. */
  #take(messageId: MessageId): void {
    this.#lines = withoutLine({ lines: this.#lines, messageId });
  }

  /**
   * Says a line a client's edit left out while it was starting, and that then did not start, is
   * gone: it is neither waiting nor running, which no other update would tell.
   */
  #reportVanished(messageId: MessageId): void {
    if (this.#closed() || this.#lines.some((line) => line.messageId === messageId)) return;
    this.#publish({ type: 'queue_changed', queued: this.lines, dropped: [messageId] });
  }

  /**
   * Tells every follower why `line` could not start. A refusal of our own making (its skill is
   * gone, a run goes) says so; anything else, or a storage failure naming its file, can hold paths
   * or a provider's reply, so followers get a fixed text and the app the error.
   */
  #refuse(params: { line: QueuedLine; caughtError: unknown }): void {
    const { line, caughtError } = params;
    const own =
      caughtError instanceof SessionError ||
      (caughtError instanceof ConversationsError && caughtError.reason !== 'storage_failed');

    if (!own) this.#onStartFailure(caughtError);
    this.#publish({
      type: 'prompt_refused',
      messageId: line.messageId,
      text: line.text,
      error: own ? caughtError.message : 'This line could not start; the server log says why',
      queued: this.lines,
    });
  }

  /** Waits until no run goes and no prompt is being prepared, asking a run to end when it can. */
  async #untilFree(): Promise<void> {
    while (!this.#closed()) {
      if (this.#conversation.state !== 'idle') {
        this.#conversation.yieldPrompt();
        await this.#conversation.whenIdle();
        continue;
      }

      const preparing = this.#preparing();

      if (!preparing) return;
      await preparing;
    }
  }
}

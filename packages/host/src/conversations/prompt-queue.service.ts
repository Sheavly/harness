import { StoreError } from '@sheavly/core/errors/store.errors';
import type { QueueUpdate } from '@sheavly/protocol/queue/queue.types';
import { queuedPromptsSchema } from '@sheavly/protocol/server/server.validator';
import { SessionError } from '@sheavly/runtime/errors/sessions.errors';
import type { Conversation } from '../conversation/conversation.types.js';
import { ConversationsError } from '../errors/conversations.errors.js';

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
 */
export class PromptQueue {
  #lines: string[];
  #parked: boolean;
  #draining = false;
  readonly #conversation: Pick<Conversation, 'state' | 'yieldPrompt' | 'whenIdle' | 'deferWakes'>;
  readonly #preparing: () => Promise<void> | undefined;
  readonly #start: (params: { text: string; taken: () => readonly string[] }) => Promise<void>;
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
     * Starts `text` as the next prompt; rejects when it can't. It calls `taken` as the prompt
     * starts, which takes the line out of the queue and returns the lines left behind it.
     */
    start: (params: { text: string; taken: () => readonly string[] }) => Promise<void>;
    publish: (update: QueueUpdate) => void;
    keep: (lines: readonly string[]) => Promise<void>;
    onStoreFailure: (failure: StoreError) => void;
    /** Hears why a line could not start when it is not a refusal the user can act on. */
    onStartFailure: (error: unknown) => void;
    /** Whether the conversation is gone: nothing starts after that. */
    closed: () => boolean;
  }) {
    this.#lines = [...params.restored];
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
    return [...this.#lines];
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
   * Puts `line` behind the waiting ones, releases parked ones, and starts the runner. Returns the
   * lines after it. Throws `cannot_queue`, changing nothing, for a line longer than a queued line
   * may be or a full queue.
   */
  async add(line: string): Promise<string[]> {
    const queued = [...this.#lines, line];

    if (!queuedPromptsSchema.safeParse({ queued }).success) {
      throw new ConversationsError({
        reason: 'cannot_queue',
        message: 'This line cannot wait in the queue: it is too long for it, or the queue is full',
      });
    }

    this.#parked = false;
    await this.#change(queued);
    this.#run();

    return this.lines;
  }

  /**
   * Replaces the waiting lines whole, as a client edited them. Lines waiting behind a run keep
   * waiting for it; put while none waits, they are parked: an edit never starts a prompt itself,
   * only the next line sent does.
   */
  async replace(lines: readonly string[]): Promise<void> {
    if (!this.#draining) this.#parked = lines.length > 0;
    await this.#change([...lines]);
    this.#run();
  }

  /** Lines wait that may start: some, and not parked. */
  get #waiting(): boolean {
    return this.#lines.length > 0 && !this.#parked;
  }

  async #change(lines: string[]): Promise<void> {
    const same = lines.length === this.#lines.length && lines.every((l, i) => l === this.#lines[i]);

    this.#lines = lines;
    this.syncWakes();
    // A client that puts the same lines again changes nothing on the stream or on disk.
    if (same) return;
    this.#publish({ type: 'queue_changed', queued: this.lines });
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
      const [text] = this.#lines;

      if (text === undefined || !this.#waiting || this.#closed()) return;

      // The line stays in the queue until it has started, so a close or a stop before that keeps it.
      if ((await this.#startOrRefuse(text)) === 'kept') {
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
   * Starts `text`, or reports why it can't; `kept` when a close, or a stop reaching the line while
   * its skills were prepared, came before it started: it stays in the queue.
   */
  async #startOrRefuse(text: string): Promise<'started' | 'refused' | 'kept'> {
    let taken = false;
    const take = () => {
      taken = true;
      this.#take(text);

      return this.lines;
    };

    try {
      await this.#start({ text, taken: take });

      return 'started';
    } catch (caughtError) {
      const stopped = caughtError instanceof Error && caughtError.name === 'AbortError';

      if (!taken && (this.#closed() || stopped)) return 'kept';
      if (!taken) this.#take(text);
      this.#refuse({ text, caughtError });

      return 'refused';
    }
  }

  /** Takes the first `text` out of the waiting lines. */
  #take(text: string): void {
    const at = this.#lines.indexOf(text);

    if (at >= 0) this.#lines = this.#lines.toSpliced(at, 1);
  }

  /**
   * Tells every follower why `text` could not start. A refusal of our own making (its skill is
   * gone, a run goes) says so; anything else, or a storage failure naming its file, can hold paths
   * or a provider's reply, so followers get a fixed text and the app the error.
   */
  #refuse(params: { text: string; caughtError: unknown }): void {
    const { text, caughtError } = params;
    const own =
      caughtError instanceof SessionError ||
      (caughtError instanceof ConversationsError && caughtError.reason !== 'storage_failed');

    if (!own) this.#onStartFailure(caughtError);
    this.#publish({
      type: 'prompt_refused',
      text,
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

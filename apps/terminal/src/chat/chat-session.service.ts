import type { Renderer } from '../render/render.service.js';
import type { RunningTool, Write } from '../render/render.types.js';
import { defaultPalette } from '../theme/palette.utils.js';
import type { Palette } from '../theme/theme.types.js';
import { unknownPromptCommand } from './chat-prompt.helper.js';
import type { LinkFile } from '../changes/changes.types.js';
import { describeChanges, describeFailures, describeLatest } from './chat-describe.helper.js';
import { CHAT_HELP, LINE_COLUMNS } from './chat.constants.js';
import type { ChatConversation, ChatRun, Describer, RunState, TurnOutcome } from './chat.types.js';
import { failedRunMessage, mainRunStart, mainRunState, parseChatInput } from './chat.utils.js';
import type { StopResult } from '../interrupt/interrupt.types.js';
import { describeFailure, plainTerminalText } from '../render/terminal-text.utils.js';
import { runEffortCommand, runModelCommand } from './chat-model.helper.js';
import type { QueueUpdate } from '@sheavly/protocol/queue/queue.types';
import { runEnd } from '@sheavly/protocol/status/run-end.utils';
import type { StreamEntry } from '@sheavly/protocol/stream/stream.types';

/** The main run going, as the stream told it, and whether the user asked to stop it. */
type HeardRun = ChatRun & { stopAsked: boolean };

/**
 * The chat's logic, apart from how a person types to it or sees it: lines go in (`submit`), the
 * conversation's output comes out through `write`. The backend owns whether the conversation is
 * busy: a prompt is sent at once and the backend starts it or keeps it in its own queue, and
 * everything shown (the echo, the run's output, the queue, its end) comes from the conversation's
 * stream through `hear`. A UI decides what a key does (Ctrl+C is `stop`) and what to show; this
 * only does it.
 *
 * The chat's commands (`/help`, `/model`, `/exit`) and skills (`/<name>`) are read here, so every
 * UI that has a text box treats them the same.
 */
export class ChatSession {
  readonly #conversation: ChatConversation;
  readonly #renderer: Renderer;
  readonly #mainSession: string;
  readonly #write: Write;
  readonly #onQueue: (queue: readonly string[]) => void;
  readonly #onBusy: (busy: boolean) => void;
  readonly #onSend: (text: string) => void;
  readonly #onTurnEnd: (outcome: TurnOutcome) => void;
  readonly #onReplyComplete: () => void;
  readonly #onTools: (tools: readonly RunningTool[]) => void;
  readonly #onUsage: (entry: StreamEntry) => void;
  readonly #onExit: () => void;
  readonly #describer: Describer;
  readonly #onThinking: (thinking: boolean) => void;
  readonly #onRunState: (state: RunState) => void;
  #reportedTools: readonly RunningTool[];
  #reportedThinking = false;
  /** What the UI was last told, so `onBusy` fires on a change only. */
  #reportedBusy = false;
  /** The newest entry shown: each entry is shown once. */
  #shownSeq = -1;
  /** From the main run's start on the stream to its `done`. */
  #run: HeardRun | undefined;
  /** The backend's queue, as its newest `queue` entry (or the read at start) said. */
  #queued: readonly string[] = [];
  /** The seq of the newest line the backend started or refused from its queue. */
  #lastQueueStep = -1;
  /**
   * The newest seq shown when the backend last accepted a line: that line's run is owed until a
   * line has started after it and none waits, as the stream and the answer race each other.
   */
  #owedAfter: number | undefined;
  /** Lines typed and not yet handled; they are handled one at a time, in the order typed. */
  #handling = 0;
  #work: Promise<void> = Promise.resolve();
  #idleWaiters: (() => void)[] = [];
  #ended = false;
  #dropping: Promise<void> | undefined;

  constructor(params: {
    conversation: ChatConversation;
    renderer: Renderer;
    /** The id of the conversation's main session: only its events are shown. */
    mainSession: string;
    write: Write;
    /** Told whenever the backend's queue of waiting lines changes. */
    onQueue?: (queue: readonly string[]) => void;
    /** Told when a main run starts, the user's or the backend's own, and when it ends. */
    onBusy?: (busy: boolean) => void;
    /** Told when the backend starts a line the user sent (not when it is queued), to show it. */
    onSend?: (text: string) => void;
    /** Told when the user's line has run to its end, after all its output was written. */
    onTurnEnd?: (outcome: TurnOutcome) => void;
    /** After all output, only for a backend-confirmed completed prompt, never errors or stops. */
    onReplyComplete?: () => void;
    /** Makes a file path in what `/changes` prints a link; a path as it is if none. */
    linkFile?: LinkFile;
    /** Told whenever the set of tools running changes, so a UI can show what it waits on. */
    onTools?: (tools: readonly RunningTool[]) => void;
    /** Told when the main session's model starts or stops signalling reasoning. */
    onThinking?: (thinking: boolean) => void;
    /**
     * Told when the main run says it works, or is held open waiting on this many grouped tasks
     * (0 when only ungrouped tasks or services remain).
     */
    onRunState?: (state: RunState) => void;
    /** Usage entries from every session, including sub-agents; seq allows replay deduplication. */
    onUsage?: (entry: StreamEntry) => void;
    /** Told once, when the user asked to leave. */
    onExit: () => void;
    /** The terminal's width now, which a diff is cut to; a plain line terminal has none. */
    columns?: () => number;
    /** The colours of what `/changes` and `/errors` print; the default theme's if none. */
    palette?: Palette;
  }) {
    this.#conversation = params.conversation;
    this.#renderer = params.renderer;
    this.#reportedTools = params.renderer.running;
    this.#mainSession = params.mainSession;
    this.#write = params.write;
    this.#onQueue = params.onQueue ?? (() => undefined);
    this.#onBusy = params.onBusy ?? (() => undefined);
    this.#onSend = params.onSend ?? (() => undefined);
    this.#onTurnEnd = params.onTurnEnd ?? (() => undefined);
    this.#onReplyComplete = params.onReplyComplete ?? (() => undefined);
    this.#onTools = params.onTools ?? (() => undefined);
    this.#onThinking = params.onThinking ?? (() => undefined);
    this.#onRunState = params.onRunState ?? (() => undefined);
    this.#onUsage = params.onUsage ?? (() => undefined);
    this.#onExit = params.onExit;
    this.#describer = {
      renderer: params.renderer,
      palette: params.palette ?? defaultPalette,
      columns: params.columns ?? (() => LINE_COLUMNS),
      linkFile: params.linkFile ?? ((path) => path),
    };
  }

  /** The lines waiting in the backend's queue, oldest first, as its stream last said. */
  get queued(): readonly string[] {
    return this.#queued;
  }

  /**
   * Handles a line after the ones typed before it: a chat command runs here at once, even while a
   * run goes; a prompt is sent to the backend, which starts it or queues it.
   */
  submit(line: string): void {
    if (this.#ended) return;
    this.#handling += 1;
    this.#work = this.#work.then(async () => {
      try {
        await this.#handle(line);
      } finally {
        this.#handling -= 1;
        this.#settle();
      }
    });
  }

  /** What `/changes <target>` says: the files changed in this chat, or the diffs `target` names. */
  describeChanges(target?: string): string {
    return describeChanges({ from: this.#describer, target });
  }

  /** What `/errors <target>` says: the failed steps with more to say, or the one `target` names. */
  describeFailures(target?: string): string {
    return describeFailures({ from: this.#describer, target });
  }

  /** The newest collapsed line's whole text, for a key that expands it. */
  describeLatest(): string {
    return describeLatest(this.#describer);
  }

  /**
   * Resolves when no line typed is still being handled, no main run goes, and every line the
   * backend accepted from this chat has run or been refused.
   */
  idle(): Promise<void> {
    return new Promise((resolve) => {
      this.#idleWaiters.push(resolve);
      this.#settle();
    });
  }

  /**
   * Stops the main run going, the user's or the backend's own; its history stays valid. Lines
   * waiting stay in the backend's queue and run after it: stopping a prompt is not leaving.
   */
  stop(): StopResult {
    const run = this.#run;

    if (!run) return 'idle';
    if (run.stopAsked) return 'stopping';
    run.stopAsked = true;
    this.#conversation
      .stop()
      .catch((caughtError: unknown) =>
        this.#print(`✗ Could not stop the run: ${describeFailure(caughtError)}`),
      );

    return 'stopped';
  }

  /**
   * Shows the lines the backend kept from an earlier run, read at start: they wait without
   * running until the user sends the next line, as reopening never sends pending input.
   */
  restoreQueued(lines: readonly string[]): void {
    this.#showQueue(lines);
  }

  /** Drops the backend's waiting lines, which a user who is leaving does not want sent; once. */
  dropQueued(): Promise<void> {
    this.#dropping ??= this.#conversation
      .setQueue([])
      .catch((caughtError: unknown) =>
        this.#print(`✗ Could not drop the queued lines: ${describeFailure(caughtError)}`),
      );

    return this.#dropping;
  }

  /**
   * Shows one entry of the conversation's stream, once by seq, and follows the main run's start
   * and end, the backend's queue and the live state (tools, thinking, run state) from it.
   */
  hear(entry: StreamEntry): void {
    if (entry.seq <= this.#shownSeq) return;
    this.#shownSeq = entry.seq;

    if (entry.kind === 'queue') this.#hearQueue({ update: entry.update, seq: entry.seq });

    const start = mainRunStart({ entry, mainSession: this.#mainSession });

    if (start) this.#startRun(start);
    if (entry.kind === 'event' && entry.event.type === 'usage') this.#onUsage(entry);

    const runState = mainRunState({ entry, mainSession: this.#mainSession });

    if (runState) this.#onRunState(runState);
    this.#renderer.entry(entry, this.#mainSession);

    const message = failedRunMessage({ entry, mainSession: this.#mainSession });

    if (message) this.#print(`  message ${message}`);
    this.#reportLiveState();

    const outcome = runEnd(entry);

    if (outcome) this.#endRun(outcome);
    this.#settle();
  }

  /** The stream is lost for good: a run still going ended without its `done`, so it failed. */
  lostStream(caughtError: unknown): void {
    this.#print(`✗ lost the live stream: ${describeFailure(caughtError)}`);
    if (this.#run) this.#endRun('failed');
    // Nothing more will be heard, so nothing the backend owes can arrive.
    this.#owedAfter = undefined;
    this.#settle();
  }

  async #handle(line: string): Promise<void> {
    // A line typed after `/exit` is dropped with what waited.
    if (this.#ended) return;

    const parsed = parseChatInput(line);

    switch (parsed.kind) {
      case 'exit':
        this.#ended = true;
        void this.dropQueued();
        this.#onExit();
        break;
      case 'help':
        this.#print(CHAT_HELP);
        break;
      case 'usage':
        this.#print(`${parsed.message} /help lists the commands.`);
        break;
      case 'changes':
        this.#print(this.describeChanges(parsed.target));
        break;
      case 'errors':
        this.#print(this.describeFailures(parsed.target));
        break;
      case 'model':
        await this.#printCommand(() =>
          runModelCommand({ conversation: this.#conversation, typed: parsed.name }),
        );
        break;
      case 'effort':
        await this.#printCommand(() =>
          runEffortCommand({ conversation: this.#conversation, typed: parsed.name }),
        );
        break;
      case 'prompt':
        await this.#printCommand(() => this.#sendPrompt(parsed.text));
        break;
      case 'empty':
        break;
    }
  }

  #print(text: string): void {
    this.#write(`${text}\n`);
  }

  async #printCommand(run: () => Promise<string | undefined>): Promise<void> {
    try {
      const said = await run();

      if (said !== undefined) this.#print(said);
    } catch (caughtError) {
      this.#print(`✗ ${describeFailure(caughtError)}`);
    }
  }

  /**
   * Sends a message, which runs any skills it mentions (`/<name>` anywhere in it); one it starts
   * with that no skill has is an unknown command, reported instead of sent. What it does is heard
   * on the stream; what is returned is printed.
   */
  async #sendPrompt(text: string): Promise<string | undefined> {
    const unknown = await unknownPromptCommand({ text, conversation: this.#conversation });

    if (unknown) return `Unknown command /${unknown}; /help lists them.`;

    const sentAfter = this.#shownSeq;

    await this.#conversation.submit(text);
    this.#owedAfter = sentAfter;

    return undefined;
  }

  /** The backend's queue changed: shown as it is now, and a line it could not start is said. */
  #hearQueue(params: { update: QueueUpdate; seq: number }): void {
    const { update, seq } = params;

    this.#showQueue(update.queued);

    if (update.type === 'queue_changed') {
      // Only a client empties the queue this way (the backend takes lines with `prompt_started`):
      // the lines this chat sent were taken out, so none of them is owed any more.
      const emptied = update.queued.length === 0 && seq > (this.#owedAfter ?? seq);

      if (emptied) this.#owedAfter = undefined;

      return;
    }

    this.#lastQueueStep = seq;

    if (update.type === 'prompt_refused') {
      this.#print(`✗ ${plainTerminalText(update.text)}: ${plainTerminalText(update.error)}`);
    }
  }

  #showQueue(queued: readonly string[]): void {
    this.#queued = [...queued];
    this.#onQueue(this.#queued);
  }

  /** A run's start; a line's `prompt_started` after its resume makes the run going the user's. */
  #startRun(start: ChatRun): void {
    const going = this.#run;

    if (going && (going.owner === 'user' || start.owner === 'backend')) return;
    this.#run = { ...start, stopAsked: going?.stopAsked ?? false };
    if (start.owner === 'user') this.#onSend(start.text);
    this.#reportBusy();
  }

  /** The main run's end: a user's line ends its turn, and a completed one that was not stopped is a reply. */
  #endRun(outcome: TurnOutcome): void {
    const run = this.#run;

    this.#run = undefined;
    // A stopped or failed run can end without the result of a call that was running.
    this.#renderer.clearRunning();
    this.#reportLiveState();

    if (run?.owner === 'user') {
      this.#write('\n');
      if (outcome === 'completed' && !run.stopAsked) this.#onReplyComplete();
      this.#onTurnEnd(outcome);
    }

    this.#reportBusy();
  }

  /** Resolves the `idle` waiters once nothing is handled, runs, or is owed by the backend. */
  #settle(): void {
    if (this.#handling > 0 || this.#run) return;

    if (this.#owedAfter !== undefined) {
      if (this.#lastQueueStep <= this.#owedAfter || this.#queued.length > 0) return;
      this.#owedAfter = undefined;
    }

    for (const resolve of this.#idleWaiters.splice(0)) resolve();
  }

  /** Tells the UI whether a main run goes, once per change. */
  #reportBusy(): void {
    const busy = this.#run !== undefined;

    if (busy === this.#reportedBusy) return;
    this.#reportedBusy = busy;
    this.#onBusy(busy);
  }

  /** Tells the UI the running tools and whether the model thinks, for what changed since. */
  #reportLiveState(): void {
    this.#reportThinking();
    this.#reportTools();
  }

  /** Tells the UI whether the model thinks, when that is not what it was last told. */
  #reportThinking(): void {
    if (this.#renderer.thinking === this.#reportedThinking) return;
    this.#reportedThinking = this.#renderer.thinking;
    this.#onThinking(this.#reportedThinking);
  }

  /** Tells the UI the running tools, when they are not the ones it was last told. */
  #reportTools(): void {
    if (this.#renderer.running === this.#reportedTools) return;
    this.#reportedTools = this.#renderer.running;
    this.#onTools(this.#reportedTools);
  }
}

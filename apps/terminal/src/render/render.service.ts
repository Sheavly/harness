import { now } from '@sheavly/core/clock/clock.helper';
import { plainTerminalText } from './terminal-text.utils.js';
import { ChangeLog } from '../changes/change-log.service.js';
import { FailureLog } from '../failures/failure-log.service.js';
import { logLook } from './log-look.utils.js';
import type { Expandable, Look, ReplySink, RunningTool, Section, Write } from './render.types.js';
import {
  commandOf,
  firstLine,
  oneLine,
  seconds,
  shortId,
  terminalConnection,
} from './render.utils.js';
import { drawToolResult } from './tool-result.helper.js';
import { MAX_EXTENSION_TEXT_CHARS } from '@sheavly/protocol/extension/extension.constants';
import type { EntryEvent } from '@sheavly/protocol/event/event.types';
import type { CallId } from '@sheavly/protocol/message/message.types';
import type { SessionUpdate } from '@sheavly/protocol/session/session.types';
import type { StreamEntry } from '@sheavly/protocol/stream/stream.types';

type EventOf<T extends EntryEvent['type']> = Extract<EntryEvent, { type: T }>;

/**
 * The terminal front end of the chat, the demo and the workbook: one line (or block) per event of
 * the main session and per sub-agent update, from the backend's stream, written to `write`.
 * It says the run waits only when `run_state` says it is held on grouped tasks. Kept stateful
 * only for the current tool batch size, the titles it holds back until their result (when the
 * look pairs steps), the reasoning count, the tools running now (`running`), and the file changes
 * and failures it has seen (`changes`, `failures`, whatever the look shows of them).
 */
export class Renderer {
  /** Every file change printed so far, for a screen to show in full when asked. */
  readonly changes = new ChangeLog();
  /** Every failed step that had more to say than its line, for a screen to show in full. */
  readonly failures = new FailureLog();
  #latest: Expandable | undefined;
  // Replaced, never changed in place, so a caller sees a change by the array not being the same.
  #running: readonly RunningTool[] = [];
  #batchSize = 0;
  /** Titles not written yet, in call order: a look that pairs steps writes each with its result. */
  #held: { id: CallId; text: string }[] = [];
  #reasoningItems = 0;
  #thinking = false;
  #last: Section | undefined;
  #lineOpen = false;

  /**
   * `look` is how it reads: the complete plain log by default, or `chatLook` for a person.
   * `reply` is where the model's text goes; by default it is written like everything else.
   */
  constructor(
    private readonly write: Write,
    private readonly look: Look = logLook,
    private readonly reply: ReplySink = { write, end: () => undefined },
  ) {}

  /** Which of the collapsed lines printed last is the newest, for Ctrl+O to expand. */
  get latestExpandable(): Expandable | undefined {
    return this.#latest;
  }

  /**
   * The tool calls that have started and not returned, oldest first. The array is replaced on
   * every change, so a caller that kept the last one knows by identity whether it changed.
   */
  get running(): readonly RunningTool[] {
    return this.#running;
  }

  /** Whether the main session's model is reasoning now, as its provider signalled it. */
  get thinking(): boolean {
    return this.#thinking;
  }

  /**
   * Forgets the running tools and any signalled reasoning, for a prompt that ended without its
   * `done` (a failure, a stop).
   * A title still held is written without a result, so what was running is not lost.
   */
  clearRunning(): void {
    this.#thinking = false;
    if (this.#running.length > 0) this.#running = [];
    this.#showHeldSteps();
  }

  /**
   * One entry of a prompt's stream: the main session's loop events, and sub-agents starting,
   * reporting and ending. A sub-agent's own events and the task entries aren't printed: its
   * updates and its task's completion say what it did.
   */
  entry(entry: StreamEntry, mainSession: string): void {
    if (entry.kind === 'event' && entry.sessionId === mainSession) this.event(entry.event);
    if (entry.kind === 'update') this.session(entry.update);
  }

  /** One loop event of the main session. */
  event(event: EntryEvent): void {
    switch (event.type) {
      case 'run_state':
        if (event.state === 'waiting' && event.groupedTasks > 0) {
          this.#activity(this.look.awaitingTasks(event.groupedTasks));
        }

        break;
      case 'usage':
      case 'harness_notice':
        // Not transcript output: usage feeds the status line, and a persistent notice (a finished
        // task, a sub-agent's report) is already drawn by `task_completed` and session updates.
        break;
      case 'text_delta':
        this.#reply(plainTerminalText(event.text));
        break;
      case 'reasoning':
        this.#reasoningItems++; // opaque; resent to the model automatically
        break;
      case 'reasoning_activity':
        this.#thinking = event.active; // content-free; shown only by the live indicator
        break;
      case 'model_connection':
        this.#activity(this.look.modelConnection(terminalConnection(event.connection)));
        break;

      case 'tool_call_started':
        this.#running = [
          ...this.#running,
          { id: event.call.id, description: event.description, startedAt: now() },
        ];
        // Already running; its result is shown after the model's turn.
        this.#startStep({
          id: event.call.id,
          description: plainTerminalText(event.description),
          command: commandOf(event.call),
        });
        break;

      case 'tool_batch':
        this.#batchSize = event.calls.length;
        if (this.#batchSize > 1) this.#activity(this.look.parallel(this.#batchSize));
        // A lone call has nothing to be mixed up with, so its title shows now. That is once the
        // model has stopped streaming (the batch is only known then), not when the call started:
        // text the model streams after a call is written before its title.
        else this.#showHeldSteps();
        break;
      case 'tool_result':
        this.#running = this.#running.filter(({ id }) => id !== event.call.id);
        this.#showHeldSteps(event.call.id);
        this.#toolResult(event);
        break;
      case 'task_running':
        this.#showHeldSteps(event.call.id);
        this.#activity(
          this.look.taskRunning({ label: this.#label(event.description), id: event.task.id }),
        );
        break;
      case 'task_completed':
        this.#taskCompleted(event);
        break;
      case 'message_received':
        this.#activity(this.look.steer(firstLine(event.message.content)));
        break;
      case 'context_added':
        this.#activity(
          this.look.contextAdded({
            hook: plainTerminalText(event.hook),
            chars: event.content.length,
          }),
        );
        break;
      case 'model_input_changed':
        this.#activity(
          this.look.modelInputChanged({
            hook: plainTerminalText(event.hook),
            added: event.added,
            removed: event.removed,
            edited: event.edited,
          }),
        );
        break;
      case 'summary_started':
        this.#activity(this.look.summaryStarted());
        break;
      case 'summary_done':
        this.#activity(
          this.look.summaryDone({
            tokensBefore: event.tokensBefore,
            tokensAfter: event.tokensAfter,
          }),
        );
        break;
      case 'summary_failed':
        this.#activity(
          this.look.summaryFailed({
            error: firstLine(event.error),
            cancelled: event.kind === 'cancellation',
          }),
        );
        break;
      case 'run_failed':
        this.clearRunning();
        this.#activity(this.look.runFailed(plainTerminalText(event.error)));
        // A failed run has no `done`, so this is where its prompt ends.
        this.reply.end();
        this.#endPrompt();
        break;
      case 'hook_failed':
        this.#activity(
          this.look.hookFailed({
            hook: plainTerminalText(event.hook),
            handler: event.handler,
            error: plainTerminalText(event.error),
          }),
        );
        break;
      case 'storage_failed':
        // Not the end of a run: the prompt carries on, and only the next one is refused.
        this.#activity(this.look.storageFailed(plainTerminalText(event.error)));
        break;
      case 'extension_event':
        // The fallback only, never `data`, and never a switch on `kind`: a kind this terminal
        // does not know still shows its text. One line, so it cannot imitate other output.
        this.#activity(
          this.look.extensionEvent({
            extension: plainTerminalText(event.extension),
            text: plainTerminalText(oneLine({ text: event.text, max: MAX_EXTENSION_TEXT_CHARS })),
          }),
        );
        break;
      case 'turn_end':
        this.#activity(this.look.turnEnd({ stopReason: event.stopReason }));
        break;
      case 'done':
        this.#done(event);
        break;
    }
  }

  /** One session update: sub-agents starting, reporting status, getting messages, ending. */
  session(update: SessionUpdate): void {
    const { session } = update;

    // The main session is not a card: only a sub-agent, which has a parent, is drawn.
    if (!('parentId' in session)) return;
    const agent = {
      indent: '  '.repeat(session.depth - 1),
      title: plainTerminalText(session.title),
      id: session.id,
    };

    // Every update kind is chosen here, so a new one fails lint until it is drawn or ignored.
    switch (update.type) {
      case 'session_started':
        this.#activity(
          this.look.subAgentStarted({
            ...agent,
            depth: session.depth,
            parent: session.parentId,
            root: session.rootId,
          }),
        );
        break;
      case 'session_status':
        this.#activity(
          this.look.subAgentStatus({ ...agent, status: plainTerminalText(session.status ?? '') }),
        );
        break;

      case 'session_message': {
        const from = update.message.from === 'user' ? 'the user' : shortId(update.message.from);
        const content = firstLine(update.message.content);

        this.#activity(this.look.subAgentMessage({ ...agent, from, content }));
        break;
      }

      case 'session_ended':
        this.#activity(this.look.subAgentEnded({ ...agent, state: session.state }));
        break;
      case 'session_idle':
      case 'session_resumed':
      case 'session_model':
      case 'session_released':
        // Drawn by nothing: idle, resume and model changes are not transcript output, and the
        // ended card is already in the scrollback when a session is released.
        break;
    }
  }

  /** The model's reply, as it streams: a section of its own, apart from what the run did. */
  #reply(text: string): void {
    if (text === '') return;
    this.#enter('reply');
    this.reply.write(text);
    this.#lineOpen = !text.endsWith('\n');
  }

  /** One thing the run did; `''` is a look choosing to show nothing. */
  #activity(text: string): void {
    if (text === '') return;
    this.#enter('activity');
    this.write(text);
    this.#lineOpen = false;
  }

  #enter(section: Section): void {
    const gap = this.look.gap({ from: this.#last, to: section, lineOpen: this.#lineOpen });

    // An empty write is not a pause in a reply: a screen ends the reply on any other output.
    if (gap !== '') this.write(gap);
    this.#last = section;
  }

  /** The prompt is over: the next one starts a fresh layout, not a gap after this one's text. */
  #done(event: EventOf<'done'>): void {
    this.clearRunning();
    this.reply.end();
    this.#activity(
      this.look.done({
        reason: event.reason,
        events: event.seq + 1,
        reasoning: this.#reasoningItems,
      }),
    );
    this.#endPrompt();
  }

  /** Forgets what only mattered within this prompt. */
  #endPrompt(): void {
    this.#last = undefined;
    this.#lineOpen = false;
    this.#reasoningItems = 0;
  }

  /** A paired title already sits above its result, so only an unpaired batch repeats it. */
  #label(description: string): string {
    return this.#batchSize > 1 && !this.look.pairSteps
      ? `${plainTerminalText(description)} · `
      : '';
  }

  /**
   * Writes a step's title now, or holds it when the look pairs steps: a batch's results all come
   * after its starts, so a title written at its start would sit above another step's result.
   */
  #startStep(step: { id: CallId; description: string; command: string | undefined }): void {
    const text = this.look.toolStarted(step);

    if (this.look.pairSteps) this.#held.push({ id: step.id, text });
    else this.#activity(text);
  }

  /** Writes the held title of step `id`, or every held title when none is named. */
  #showHeldSteps(id?: CallId): void {
    const shown = this.#held.filter((step) => id === undefined || step.id === id);

    this.#held = this.#held.filter((step) => !shown.includes(step));
    for (const { text } of shown) this.#activity(text);
  }

  #toolResult(event: EventOf<'tool_result'>): void {
    const { lines, latest } = drawToolResult({
      event,
      look: this.look,
      label: this.#label(event.description),
      changes: this.changes,
      failures: this.failures,
    });

    if (latest) this.#latest = latest;
    for (const text of lines) this.#activity(text);
  }

  #taskCompleted({ task }: EventOf<'task_completed'>): void {
    this.#activity(
      this.look.taskCompleted({
        ok: task.status === 'completed',
        id: task.id,
        status: task.status,
        exit: task.exitCode === undefined ? '' : ` · exit ${task.exitCode ?? '?'}`,
        elapsed: seconds((task.endedAt ?? now()) - task.startedAt),
        command: plainTerminalText(task.command),
        output: firstLine(task.error ?? task.output.split('\n').filter(Boolean).at(-1) ?? ''),
      }),
    );
  }
}

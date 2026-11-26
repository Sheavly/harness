import { matchesKey, type Editor, type TUI } from '@earendil-works/pi-tui';
import { now } from '@sheavly/core/clock/clock.helper';
import { plainTerminalText } from '../render/terminal-text.utils.js';
import type { ApprovalRequest } from '@sheavly/protocol/approval/approval.types';
import type { ApprovalAsker } from '../client/client.types.js';
import { CHAT_COMMANDS } from '../chat/chat.constants.js';
import type { TurnOutcome } from '../chat/chat.types.js';
import type { ShellMark } from '../marks/marks.types.js';
import { CodeFence } from '../markdown/code-fence.service.js';
import { MarkdownStream } from '../markdown/markdown-stream.service.js';
import { renderMarkdown } from '../markdown/render-markdown.utils.js';
import type { ReplySink } from '../render/render.types.js';
import type { Palette } from '../theme/theme.types.js';
import type { ChatView } from './chat-view.types.js';
import { createClassicView } from './classic-view.helper.js';
import { ApprovalPrompt } from './approval-prompt.service.js';
import { QUIT_WINDOW_MS } from './tui.constants.js';
import { LineBuffer } from './line-buffer.service.js';
import type { ApprovalAnswer, ApprovalOutcome, StatusInfo } from './tui.types.js';
import { approvalText, echoText, queueText } from './view.utils.js';

/** Keys the screen reads before the editor does. `undefined` leaves the key to the editor. */
type KeyResult = { consume: true } | undefined;

/**
 * The chat on a terminal's main screen: finished lines go into the terminal's own scrollback, so
 * its search, selection and history keep working, and only a small area at the bottom is redrawn
 * (the line being written, a waiting approval, queued messages, the status line and the editor).
 *
 * It draws and reads keys; what a line, a stop or an answer does is the caller's (`ChatScreen`'s
 * callbacks). Text comes in through `write`, as the `Renderer` writes it.
 *
 * Keys, by what the user is doing: with an approval waiting and the editor empty, ↑↓ or 1-4
 * choose, Enter confirms the chosen one and Esc skips. Nothing is chosen at first, so Enter never
 * answers by accident; and once any text is typed, every key is the editor's, so a half-typed
 * line is never swallowed by a question.
 */
export class ChatScreen {
  readonly #view: ChatView;
  readonly #editor: Editor;
  readonly #lines = new LineBuffer();
  readonly #markdown = new MarkdownStream({
    render: (markdown) =>
      renderMarkdown({
        markdown,
        width: this.#view.columns,
        plain: this.#view.plain === true,
        palette: this.#view.palette,
      }),
    drawFence: (info) =>
      new CodeFence({
        info,
        width: this.#view.columns,
        plain: this.#view.plain === true,
        palette: this.#view.palette,
      }),
  });
  readonly #prompt = new ApprovalPrompt();
  readonly #callbacks: {
    onSubmit: (line: string) => void;
    onStop: () => 'stopped' | 'stopping' | 'idle';
    onAnswer: (answer: ApprovalAnswer) => void;
    onQuit: () => void;
    onExpand: () => string;
  };
  #info: StatusInfo;
  #quitArmedAt = 0;
  /** How the last turn ended, until the first row after it closes it for the terminal. */
  #ended: 'done' | 'failed' | undefined;

  constructor(
    params: ({ tui: TUI; view?: never } | { view: ChatView; tui?: never }) & {
      status: StatusInfo;
      /** The colours of the classic view it makes; a view that is passed in has its own. */
      palette?: Palette;
      /** Skill names offered after a `/`, read when the user types. */
      commands: { name: string; description?: string }[];
      cwd: string;
      onSubmit: (line: string) => void;
      /** Ctrl+C while a prompt runs; Esc only skips an approval or cancels a typed reply. */
      onStop: () => 'stopped' | 'stopping' | 'idle';
      onAnswer: (answer: ApprovalAnswer) => void;
      onQuit: () => void;
      /** Ctrl+O: the latest collapsed line in full (a diff, a failure), as text to show. */
      onExpand: () => string;
    },
  ) {
    const { status, commands, cwd, palette } = params;
    const { onSubmit, onStop, onAnswer, onQuit, onExpand } = params;

    this.#view =
      params.view ??
      createClassicView({ tui: params.tui, commands, cwd, ...(palette && { palette }) });
    this.#info = status;
    this.#callbacks = { onSubmit, onStop, onAnswer, onQuit, onExpand };
    this.#editor = this.#view.editor;
    this.#editor.onSubmit = (text) => this.#submit(text);
    this.#view.addInputListener((data) => this.#key(data));
    this.#refresh();
  }

  /** The chat's own commands, for the editor to complete; the skills come with the caller's. */
  static readonly commands = CHAT_COMMANDS.map((name) => ({ name: name.slice(1) }));

  /** Starts drawing and reading keys. */
  start(): void {
    this.#view.start();
  }

  /** Stops, leaving the terminal as it was; the conversation stays in its scrollback. */
  stop(): void {
    this.#flushTail();
    this.#view.stop();
  }

  /**
   * Where text for the conversation goes: the `Renderer`'s and the session's `write`. A reply in
   * progress is paused first, so what is written here comes after all of it; a code block it
   * interrupts is reopened by the reply's next text.
   */
  readonly write = (text: string): void => {
    // Paused, not ended: a code block this interrupts carries on after it.
    this.#show(this.#markdown.pause());
    this.#show(text);
  };

  /**
   * Where the model's reply goes, drawn as Markdown a block at a time: the `Renderer`'s `reply`.
   * The block being written shows as plain text until it is complete.
   */
  readonly reply: ReplySink = {
    write: (text) => this.#show(this.#markdown.push(text)),
    end: () => this.#endReply(),
  };

  /** Shows a line the screen itself says (a notice), apart from the conversation's text. */
  notice(text: string): void {
    this.#flushTail();
    this.#print(this.#view.palette.paint.text.secondary(plainTerminalText(text)));
    this.#view.requestRender();
  }

  /**
   * Shows a message the user sent, set apart from the reply that follows it. The message is
   * marked as a prompt and the blank row under it as where the output starts, so a terminal can
   * jump between messages.
   */
  echo(text: string): void {
    this.#flushTail();

    const rows = echoText({ text, palette: this.#view.palette }).split('\n');

    rows.forEach((row, index) => {
      if (index === 1) this.#print(row, 'prompt');
      else if (index === rows.length - 1) this.#print(row, 'output');
      else this.#print(row);
    });

    this.#view.requestRender();
  }

  /** The message that was shown ended; the next row written closes it for the terminal. */
  endTurn(outcome: TurnOutcome): void {
    this.#ended = outcome === 'completed' ? 'done' : 'failed';
  }

  /** Changes what the status line says. */
  setStatus(patch: Partial<StatusInfo>): void {
    this.#info = { ...this.#info, ...patch };
    this.#refresh();
  }

  /** Shows the lines waiting for the running one to finish. */
  setQueue(queue: readonly string[]): void {
    this.#view.setQueue(queueText({ queue, palette: this.#view.palette }));
    this.#view.requestRender();
  }

  /** An approval was asked: it waits for the user's answer, behind any already waiting. */
  ask(request: ApprovalRequest, agent?: ApprovalAsker): void {
    this.#prompt.ask(request, agent);
    this.#refresh();
  }

  /** An approval was answered elsewhere or given up on. */
  forget(id: ApprovalRequest['id']): void {
    this.#prompt.forget(id);
    this.#refresh();
  }

  /** Whether an approval waits for the user. */
  get asking(): boolean {
    return this.#prompt.current !== undefined;
  }

  /**
   * Adds a row to the history. A turn that ended is closed (OSC 133 `D`) at the first row after
   * it, as a shell closes a command with its next prompt. A row with a mark of its own would
   * take that place, so one never comes first after a turn (`echo` starts with a blank row).
   */
  #print(line: string, mark?: ShellMark): void {
    const end = this.#ended;

    this.#ended = undefined;
    this.#view.print(line, mark ?? end);
  }

  /** A block the user asked for (a diff), set apart from the text around it by blank lines. */
  #printBlock(text: string): void {
    this.#flushTail();
    this.#print('');

    for (const line of text.split('\n')) this.#print(line);
    this.#print('');
    this.#view.requestRender();
  }

  /** Prints the lines `text` finishes; the unfinished ones stay in the live area. */
  #show(text: string): void {
    for (const line of this.#lines.push(text)) this.#print(line);
    this.#view.setLive(this.#lines.tail + this.#markdown.pending);
    this.#view.requestRender();
  }

  #endReply(): void {
    this.#show(this.#markdown.flush());
  }

  #flushTail(): void {
    this.#endReply();

    const tail = this.#lines.flush();

    if (tail !== undefined) this.#print(tail);
    this.#view.setLive('');
  }

  #refresh(): void {
    this.#view.setApproval(approvalText({ prompt: this.#prompt, palette: this.#view.palette }));
    this.#view.setStatus({ ...this.#info, state: this.asking ? 'waiting' : this.#info.state });
    this.#view.requestRender();
  }

  /** What Enter in the editor does: send the line, or, while a message is asked for, answer with it. */
  #submit(text: string): void {
    const line = text.trim();

    if (this.#prompt.phase === 'message') {
      this.#finish(this.#prompt.skip(line));
      this.#editor.setText('');

      return;
    }

    if (!line) return;
    this.#editor.addToHistory(line);
    this.#editor.setText('');
    this.#callbacks.onSubmit(line);
  }

  #finish(outcome: ApprovalOutcome): void {
    if (outcome.kind === 'answer') this.#callbacks.onAnswer(outcome.answer);
    this.#refresh();
  }

  /** The keys the screen takes before the editor sees them. */
  #key(data: string): KeyResult {
    if (matchesKey(data, 'ctrl+c')) return this.#interrupt();

    if (matchesKey(data, 'ctrl+o')) {
      this.#printBlock(this.#callbacks.onExpand());

      return { consume: true };
    }

    // Ctrl+D on an empty line leaves, as in a shell; with text in the editor it deletes, as there.
    if (matchesKey(data, 'ctrl+d') && this.#editor.getText() === '' && !this.asking) {
      this.#callbacks.onQuit();

      return { consume: true };
    }

    if (!this.asking) return undefined;

    if (this.#prompt.phase === 'message') {
      if (!matchesKey(data, 'escape')) return undefined;
      this.#prompt.cancelMessage();
      this.#editor.setText('');
      this.#refresh();

      return { consume: true };
    }

    // Typing has begun: the question waits, and every key is the editor's.
    if (this.#editor.getText() !== '') return undefined;

    return this.#choose(data);
  }

  #choose(data: string): KeyResult {
    if (matchesKey(data, 'down')) this.#prompt.move(1);
    else if (matchesKey(data, 'up')) this.#prompt.move(-1);
    else if (/^[1-9]$/.test(data)) this.#prompt.pickNumber(Number(data));
    else if (matchesKey(data, 'enter')) this.#confirm();
    else if (matchesKey(data, 'escape')) this.#finish(this.#prompt.skip());
    else return undefined;

    this.#refresh();

    return { consume: true };
  }

  #confirm(): void {
    if (this.#view.canConfirm === false) return;

    const outcome = this.#prompt.confirm();

    if (outcome.kind === 'needs_message') this.#editor.setText('');
    this.#finish(outcome);
  }

  /**
   * Ctrl+C: stops a running prompt (and skips what it waits on); a press while it is still
   * stopping quits, which ends the conversation and its backend as every exit does. With nothing
   * running, the first press only arms quit and a second within a moment quits, so one stray press
   * never ends the conversation or answers an approval.
   */
  #interrupt(): KeyResult {
    const stopped = this.#callbacks.onStop();

    // Only a press that stops something skips approvals: the idle press that arms quit leaves
    // them waiting.
    if (stopped === 'stopping') {
      this.#callbacks.onQuit();

      return { consume: true };
    }

    if (stopped === 'stopped') {
      this.#skipWaiting();

      return { consume: true };
    }

    if (now() - this.#quitArmedAt < QUIT_WINDOW_MS) {
      this.#callbacks.onQuit();

      return { consume: true };
    }

    this.#quitArmedAt = now();
    this.notice('Press Ctrl+C again to quit');

    return { consume: true };
  }

  /** A stopped prompt no longer waits on its approvals: they are skipped, so it can end. */
  #skipWaiting(): void {
    for (const request of this.#prompt.drain()) {
      this.#callbacks.onAnswer({ id: request.id, response: { decision: 'skip' } });
    }

    this.#editor.setText('');
    this.#refresh();
  }
}

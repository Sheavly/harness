import type { MessageId } from '@sheavly/protocol/message/message.types';
import { MAX_MERGED_TEXT_CHARS, TEXT_DELTA_WINDOW_MS } from './nodes.constants.js';
import type { PendingText } from './nodes.types.js';

/**
 * Holds the streamed text of each channel for a short window, so the deltas of one window are
 * stored as one entry. A delta starts the window of its channel, the ones after it join the text,
 * and when the window ends (`TEXT_DELTA_WINDOW_MS`), or the writer has another entry for the channel
 * that must come after the text (`flush`), or the text would pass `MAX_MERGED_TEXT_CHARS`, what is
 * held goes to `store`, in order. Each delta joins only the ones of the same user message, so an
 * entry answers one message.
 *
 * The timer is only a window: it does not keep the process alive, and a writer that is flushed
 * (`flushAll`) does not wait for it.
 */
export class TextDeltaWindow {
  readonly #pending = new Map<string, { text: PendingText; timer: NodeJS.Timeout }>();
  readonly #store: (params: { channel: string; text: PendingText }) => void;

  /** `store` is called with a channel's text when its window ends; it must not throw. */
  constructor(store: (params: { channel: string; text: PendingText }) => void) {
    this.#store = store;
  }

  /** Adds the text of delta `seq` of `channel`, joining the window it is in or starting one. */
  add(params: {
    channel: string;
    seq: number;
    text: string;
    at: number;
    messageId?: MessageId | undefined;
  }): void {
    const { channel, seq, text, at, messageId } = params;
    const held = this.#pending.get(channel);

    if (held && this.#joins({ held: held.text, text, messageId })) {
      held.text.text += text;
      held.text.lastSeq = seq;

      return;
    }

    this.flush(channel);

    const timer = setTimeout(() => {
      this.flush(channel);
    }, TEXT_DELTA_WINDOW_MS);

    timer.unref();
    this.#pending.set(channel, { text: { seq, lastSeq: seq, text, at, messageId }, timer });
  }

  /** Stores what `channel` holds now, if anything, before whatever must come after it. */
  flush(channel: string): void {
    const held = this.#pending.get(channel);

    if (!held) return;

    clearTimeout(held.timer);
    this.#pending.delete(channel);
    this.#store({ channel, text: held.text });
  }

  /** Stores what every channel holds now. */
  flushAll(): void {
    for (const channel of [...this.#pending.keys()]) this.flush(channel);
  }

  /** Whether `text` of `messageId` joins what is held: the same message, and room for it. */
  #joins(params: { held: PendingText; text: string; messageId: MessageId | undefined }): boolean {
    const { held, text, messageId } = params;

    return held.messageId === messageId && held.text.length + text.length <= MAX_MERGED_TEXT_CHARS;
  }
}

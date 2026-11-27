import type { MessageId } from '@sheavly/protocol/message/message.types';
import type { QueuedLine } from './conversations.types.js';

/**
 * The lines a client's edit leaves, each with its id. A line whose text matches a line that was
 * waiting keeps that line's id, each old line reused once and in order (so two identical lines
 * keep their own ids); every other line gets a new one from `mint`. `dropped` is the ids of the old
 * lines nothing reused: they left the queue without starting.
 */
export function replaceLines(params: {
  current: readonly QueuedLine[];
  texts: readonly string[];
  mint: () => MessageId;
}): { lines: QueuedLine[]; dropped: MessageId[] } {
  const { current, texts, mint } = params;
  const unused = [...current];
  const lines = texts.map((text) => {
    const at = unused.findIndex((line) => line.text === text);
    const [kept] = at >= 0 ? unused.splice(at, 1) : [];

    return kept ?? { text, messageId: mint() };
  });

  return { lines, dropped: unused.map(({ messageId }) => messageId) };
}

/** `lines` without the line that has `messageId`. */
export function withoutLine(params: {
  lines: readonly QueuedLine[];
  messageId: MessageId;
}): QueuedLine[] {
  return params.lines.filter((line) => line.messageId !== params.messageId);
}

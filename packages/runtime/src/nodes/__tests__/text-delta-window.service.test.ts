import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { messageIdSchema } from '@sheavly/protocol/message/message.validator';
import { MAX_MERGED_TEXT_CHARS, TEXT_DELTA_WINDOW_MS } from '../nodes.constants.js';
import type { PendingText } from '../nodes.types.js';
import { TextDeltaWindow } from '../text-delta-window.service.js';

const FIRST = messageIdSchema.parse('00000000-0000-4000-8000-000000000001');
const SECOND = messageIdSchema.parse('00000000-0000-4000-8000-000000000002');

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
});

/** A window, and what it stored: each channel's text, in the order it was stored. */
function windowOf() {
  const stored: { channel: string; text: PendingText }[] = [];
  const window = new TextDeltaWindow((entry) => stored.push(entry));

  return { window, stored };
}

const add = (
  window: TextDeltaWindow,
  seq: number,
  text: string,
  more: { channel?: string; messageId?: typeof FIRST } = {},
) => {
  window.add({ channel: 'a', seq, text, at: 100 + seq, ...more });
};

describe('the window of streamed text', () => {
  it('stores the text of a window as one, from the first seq to the last, when it ends', () => {
    const { window, stored } = windowOf();

    add(window, 3, 'Hel');
    add(window, 4, 'lo');
    vi.advanceTimersByTime(TEXT_DELTA_WINDOW_MS - 1);

    expect(stored).toEqual([]);

    vi.advanceTimersByTime(1);

    expect(stored).toEqual([
      { channel: 'a', text: { seq: 3, lastSeq: 4, text: 'Hello', at: 103, messageId: undefined } },
    ]);
  });

  it('begins the window with the first delta: a later delta does not move its end', () => {
    const { window, stored } = windowOf();

    add(window, 0, 'a');
    vi.advanceTimersByTime(TEXT_DELTA_WINDOW_MS - 10);
    add(window, 1, 'b');
    vi.advanceTimersByTime(10);

    expect(stored).toHaveLength(1);
    expect(stored[0]?.text).toMatchObject({ text: 'ab', lastSeq: 1 });
  });

  it('holds each channel on its own', () => {
    const { window, stored } = windowOf();

    add(window, 0, 'a', { channel: 'one' });
    add(window, 0, 'b', { channel: 'two' });
    add(window, 1, 'c', { channel: 'one' });
    window.flush('one');

    expect(stored.map(({ channel, text }) => [channel, text.text])).toEqual([['one', 'ac']]);

    window.flushAll();

    expect(stored.map(({ channel, text }) => [channel, text.text])).toEqual([
      ['one', 'ac'],
      ['two', 'b'],
    ]);
  });

  it('stores what a channel holds when asked, and not again when its window ends', () => {
    const { window, stored } = windowOf();

    add(window, 0, 'a');
    window.flush('a');
    window.flush('a');
    vi.advanceTimersByTime(TEXT_DELTA_WINDOW_MS * 2);

    expect(stored).toHaveLength(1);
  });

  it('does not join the deltas of another user message', () => {
    const { window, stored } = windowOf();

    add(window, 0, 'a', { messageId: FIRST });
    add(window, 1, 'b', { messageId: SECOND });
    window.flushAll();

    expect(stored.map(({ text }) => [text.text, text.messageId])).toEqual([
      ['a', FIRST],
      ['b', SECOND],
    ]);
  });

  it('starts a new entry rather than pass what one may hold', () => {
    const { window, stored } = windowOf();
    const half = 'x'.repeat(MAX_MERGED_TEXT_CHARS / 2);

    add(window, 0, half);
    add(window, 1, half);
    add(window, 2, 'y');
    window.flushAll();

    expect(stored.map(({ text }) => text.text.length)).toEqual([MAX_MERGED_TEXT_CHARS, 1]);
  });

  it('keeps a timer that does not hold the process open, and none once flushed', () => {
    const { window } = windowOf();
    const started = vi.spyOn(globalThis, 'setTimeout');

    add(window, 0, 'a');

    // The timer itself says it is not referenced: it would not keep the process alive.
    const timer: unknown = started.mock.results[0]?.value;

    expect(timer).toMatchObject({ hasRef: expect.any(Function) as () => boolean });
    expect((timer as NodeJS.Timeout).hasRef()).toBe(false);
    expect(vi.getTimerCount()).toBe(1);
    window.flushAll();
    expect(vi.getTimerCount()).toBe(0);
  });
});

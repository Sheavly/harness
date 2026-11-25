import { describe, expect, it } from 'vitest';
import type { Message } from '@sheavly/protocol/message/message.types';
import { callIdSchema } from '@sheavly/protocol/message/message.validator';
import { maskOldToolOutput } from '../mask.utils.js';

const call = (id: string): Message => ({
  role: 'assistant',
  content: '',
  toolCalls: [{ id: callIdSchema.parse(id), name: 'read_file', input: {} }],
});
const result = (id: string, content: string, isError = false): Message => ({
  role: 'tool',
  toolCallId: callIdSchema.parse(id),
  content,
  isError,
});
/** `count` call/result pairs, each result `size` characters long. */
const pairs = (count: number, size: number): Message[] =>
  Array.from({ length: count }, (_, index) => [
    call(`c${String(index)}`),
    result(`c${String(index)}`, `result ${String(index)} ${'x'.repeat(size)}`),
  ]).flat();
const prompt: Message = { role: 'user', content: 'go' };
const contentOf = (message: Message | undefined) =>
  message?.role === 'tool' ? message.content : '';
const isHidden = (message: Message | undefined) => contentOf(message).startsWith('[An earlier');

/** The tool results of `view` after masking at a 30k window, and how many were hidden. */
function masked(view: readonly Message[]) {
  const tools = maskOldToolOutput({ view, window: 30_000 }).filter(
    (message) => message.role === 'tool',
  );

  return { tools, hidden: tools.filter(isHidden).length };
}

describe('maskOldToolOutput', () => {
  it('hides nothing below the start share of the window, or with no known window', () => {
    const view = [prompt, ...pairs(30, 2_000)];

    expect(maskOldToolOutput({ view, window: 10_000_000 })).toBe(view);
    expect(maskOldToolOutput({ view, window: undefined })).toBe(view);
  });

  it('hides the oldest results in whole steps and keeps the newest quarter of the window whole', () => {
    const { tools, hidden } = masked([prompt, ...pairs(30, 2_000)]);

    // A quarter of 30k tokens holds the newest 14 results (about 500 tokens each); of the other
    // 16, a whole number of steps (half the kept count, 7) is hidden: 14.
    expect(hidden).toBe(14);
    expect(contentOf(tools[14])).toContain('result 14');
    expect(contentOf(tools[29])).toContain('result 29');
  });

  it('always keeps the newest result whole, even when it alone is bigger than the keep share', () => {
    const { tools, hidden } = masked([prompt, ...pairs(12, 20_000)]);

    expect(contentOf(tools.at(-1))).toContain('result 11');
    // Only the newest is kept, so every older one is hidden, one step at a time.
    expect(hidden).toBe(11);
  });

  it('hides old results when there are only a few large ones, in smaller steps', () => {
    const { tools, hidden } = masked([prompt, ...pairs(8, 8_000)]);

    expect(hidden).toBeGreaterThan(0);
    expect(contentOf(tools.at(-1))).toContain('result 7');
  });

  it('keeps every call paired with its result, in order, and the error flag', () => {
    const view = [prompt, ...pairs(30, 2_000), result('x', 'failed '.repeat(200), true)];
    const masked = maskOldToolOutput({ view, window: 30_000 });

    expect(masked).toHaveLength(view.length);
    expect(masked.map((message) => message.role)).toEqual(view.map((message) => message.role));
    expect(
      masked.filter((message) => message.role === 'tool').every((tool) => 'isError' in tool),
    ).toBe(true);
  });

  it('says how big a hidden result was and that the tool can be called again', () => {
    const masked = maskOldToolOutput({ view: [prompt, ...pairs(30, 2_000)], window: 30_000 });

    expect(contentOf(masked[2])).toMatch(/^\[An earlier tool result of \d+ characters was hidden/);
    expect(contentOf(masked[2])).toContain('call the tool again');
  });

  it('keeps the line that says where the complete output is stored', () => {
    const stored = result(
      'c0',
      `${'y'.repeat(2_000)}\nFull output: output_ref=abc123 (9000 bytes stored, complete)\nmore`,
    );
    const view = [prompt, call('c0'), stored, ...pairs(30, 2_000).slice(0)];
    const masked = maskOldToolOutput({ view, window: 30_000 });

    expect(contentOf(masked[2])).toContain('Full output: output_ref=abc123');
    expect(contentOf(masked[2])).not.toContain('yyyy');
  });

  it('keeps the whole reference line when it holds U+2028, which is no line end here', () => {
    const stored = result(
      'c0',
      `${'y'.repeat(2_000)}\nFull output: output_ref=abc123 (9000\u2028bytes stored, complete)\nmore`,
    );
    const masked = maskOldToolOutput({
      view: [prompt, call('c0'), stored, ...pairs(30, 2_000)],
      window: 30_000,
    });

    expect(contentOf(masked[2])).toContain('(9000\u2028bytes stored, complete)');
  });

  it('leaves a short result alone, since the note would be as long', () => {
    const view = [prompt, call('s'), result('s', 'ok'), ...pairs(30, 2_000)];
    const masked = maskOldToolOutput({ view, window: 30_000 });

    expect(contentOf(masked[2])).toBe('ok');
  });

  it('only ever hides more as results are added, so a call is never un-hidden', () => {
    const view = [prompt, ...pairs(40, 2_000)];
    const earlier = maskOldToolOutput({ view: view.slice(0, 1 + 2 * 30), window: 30_000 });
    const later = maskOldToolOutput({ view, window: 30_000 });
    const hiddenIn = (messages: readonly Message[]) =>
      messages.flatMap((message, index) =>
        contentOf(message).startsWith('[An earlier') ? [index] : [],
      );

    for (const index of hiddenIn(earlier)) expect(hiddenIn(later)).toContain(index);
  });
});

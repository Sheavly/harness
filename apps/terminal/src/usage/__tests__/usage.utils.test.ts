import { describe, expect, it } from 'vitest';
import { usageFigures } from '@sheavly/client/testing/frames.fake';
import { usageText } from '../usage.utils.js';
import { statusText } from '../../tui/view.utils.js';

describe('usageText', () => {
  const empty = usageFigures(0);
  const context = { used: 12_756, window: 1_000_000 };

  it('shows a conversation that has made no call as an empty context', () => {
    expect(usageText({ context: undefined, usage: empty })).toBe('context 0');
  });

  it.each([
    ['usage that has not arrived', undefined, undefined],
    [
      'an older conversation whose earlier calls are not counted',
      undefined,
      { ...empty, incomplete: true },
    ],
    ['a call that reported no tokens', undefined, { ...empty, calls: 1, missingUsageCalls: 1 }],
  ])('shows unknown context instead of zero for %s', (_name, context, usage) => {
    expect(usageText({ context, usage })).toBe('context ?');
  });

  it('shows unknown context instead of zero or cumulative billing tokens', () => {
    expect(usageText({ context: { window: 300_000 }, usage: undefined })).toBe('context ? / 300K');
    expect(usageText({ context: { window: 1_000_000 }, usage: undefined })).toBe('context ? / 1M');
    expect(usageText({ context: { used: 42 }, usage: undefined })).toBe('context 42');
  });

  it('formats the latest context against its window and keeps cumulative cost separate', () => {
    expect(
      usageText({
        context,
        usage: { ...empty, calls: 20, inputTokens: 1_200_000, estimatedCostUsd: 0.1234 },
      }),
    ).toBe('context 12.8k / 1M (1%) · ~$0.1234');
    expect(usageText({ context: { ...context, used: 0 }, usage: undefined })).toBe(
      'context 0 / 1M (0%)',
    );
  });

  it('shows what the last call read from the prompt cache, including none', () => {
    expect(usageText({ context: { ...context, cached: 10_000 }, usage: undefined })).toBe(
      'context 12.8k / 1M (1%) · cache 10.0k',
    );
    expect(usageText({ context: { ...context, cached: 0 }, usage: undefined })).toBe(
      'context 12.8k / 1M (1%) · cache 0',
    );
  });

  it('uses the same context metrics in the classic status line', () => {
    expect(
      statusText({
        info: {
          state: 'ready',
          model: 'Fast',
          mode: 'ask',
          tasks: 0,
          context,
          usage: { ...empty, calls: 1 },
        },
      }),
    ).toContain('context 12.8k / 1M (1%) · ~$0.0000');
  });

  it.each([
    { ...empty, calls: 2, missingUsageCalls: 1 },
    { ...empty, calls: 1, unpricedCalls: 1 },
    { ...empty, calls: 1, incomplete: true, estimatedCostUsd: 0.1 },
  ])('omits incomplete or unknown billing without hiding context', (usage) => {
    expect(usageText({ context, usage })).toBe('context 12.8k / 1M (1%)');
  });
});

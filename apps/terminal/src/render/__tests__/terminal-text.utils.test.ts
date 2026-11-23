import { describe, expect, it } from 'vitest';
import { describeFailure, plainTerminalText } from '../terminal-text.utils.js';

describe('describeFailure', () => {
  it('says an error’s message, and a thrown value that is not an error as text', () => {
    expect(describeFailure(new Error('backend down'))).toBe('backend down');
    expect(describeFailure('plain')).toBe('plain');
  });

  it('adds what its causes say, in brackets, so a failed fetch says why', () => {
    const timeout = new Error('Headers Timeout Error');
    const refused = new Error('connect ECONNREFUSED 127.0.0.1:4310');

    expect(describeFailure(new TypeError('fetch failed', { cause: timeout }))).toBe(
      'fetch failed (Headers Timeout Error)',
    );
    expect(
      describeFailure(
        new Error('Lost the stream', { cause: new TypeError('fetch failed', { cause: refused }) }),
      ),
    ).toBe('Lost the stream (fetch failed: connect ECONNREFUSED 127.0.0.1:4310)');
  });

  it('skips a cause whose words it already says, and names one with no message by its code', () => {
    const fetchFailed = new TypeError('fetch failed', {
      cause: Object.assign(new AggregateError([], ''), { code: 'ECONNREFUSED' }),
    });

    expect(
      describeFailure(new Error('Lost the stream: fetch failed', { cause: fetchFailed })),
    ).toBe('Lost the stream: fetch failed (ECONNREFUSED)');
  });

  it('stops at a cause chain that loops back', () => {
    const first = new Error('first');
    const second = new Error('second', { cause: first });

    first.cause = second;

    expect(describeFailure(first)).toBe('first (second)');
  });

  it('shows control characters in a message or a cause as visible codes', () => {
    expect(describeFailure(new Error('a\u001b]52', { cause: new Error('b\u0007') }))).toBe(
      'a\\u001b]52 (b\\u0007)',
    );
  });
});

describe('plainTerminalText', () => {
  it('preserves Markdown, source backslashes, newlines and tabs', () => {
    const text = '**bold**\n\tconst x = "\\n"; 界🙂';

    expect(plainTerminalText(text)).toBe(text);
  });

  it('makes controls visible, including independently streamed pieces of an OSC sequence', () => {
    expect(
      plainTerminalText('before\u001b]') + plainTerminalText('52;c;data\u0007after\u202e'),
    ).toBe('before\\u001b]52;c;data\\u0007after\\u202e');
  });
});

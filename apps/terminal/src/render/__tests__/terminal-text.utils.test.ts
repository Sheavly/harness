import { SINGLE_LINE_PATTERN } from '@sheavly/protocol/node/node.constants';
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

describe('the title rule of the wire model', () => {
  // The protocol refuses a node title the characters this file escapes, newline and tab too (a
  // title is one line), and lone surrogates and private-use characters, which are not text. The
  // protocol cannot import this file, so the two classes are held together here.
  const codePoints = [
    ...Array.from({ length: 0x10000 }, (_unused, code) => code),
    0xe0001, // a tag character, a format character outside the basic plane
    0xe0020,
  ];
  const notText = /[\p{Cs}\p{Co}]/u;

  it('refuses every character the terminal escapes, and escapes every one it refuses', () => {
    const disagreements = codePoints
      .map((code) => String.fromCodePoint(code))
      .filter((character) => !notText.test(character) && !'\n\t'.includes(character))
      .filter((character) => {
        const refused = !SINGLE_LINE_PATTERN.test(character);
        const escaped = plainTerminalText(character) !== character;

        return refused !== escaped;
      })
      .map((character) => `U+${character.codePointAt(0)?.toString(16) ?? '?'}`);

    expect(disagreements).toEqual([]);
  });

  it('refuses newline and tab, which the terminal keeps for Markdown, since a title is one line', () => {
    expect(SINGLE_LINE_PATTERN.test('\n')).toBe(false);
    expect(SINGLE_LINE_PATTERN.test('\t')).toBe(false);
    expect(plainTerminalText('\n\t')).toBe('\n\t');
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

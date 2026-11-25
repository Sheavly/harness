import { describe, expect, it } from 'vitest';
import { escapedLine, escapeTags, fenceDashes, neutralize, oneLine } from '../text.utils.js';

describe('fenceDashes', () => {
  it('is at least three dashes and longer than any run in the body', () => {
    expect(fenceDashes('')).toBe('---');
    expect(fenceDashes('a - b')).toBe('---');
    expect(fenceDashes('x ------ y')).toBe('-'.repeat(7));
  });

  it('handles a body with very many dash runs without throwing', () => {
    const body = '- item\n'.repeat(300_000);

    expect(fenceDashes(body)).toBe('---');
  });
});

describe('escapeTags and neutralize', () => {
  it('swaps every < and its lookalikes, and leaves headings alone in escapeTags', () => {
    expect(escapeTags('<a>＜b﹤〈❮')).toBe('‹a>‹b‹‹‹');
    expect(escapeTags('# heading')).toBe('# heading');
  });

  it('also escapes a heading at a line start in neutralize', () => {
    expect(neutralize('x\n  # head')).toBe('x\n  \\# head');
  });

  it('escapes a heading after every character a reader may take for a line break', () => {
    expect(neutralize('# a')).toBe('\\# a');
    expect(neutralize('x\r# a\u2028# b\u2029# c\n\n# d')).toBe(
      'x\r\\# a\u2028\\# b\u2029\\# c\n\n\\# d',
    );
  });

  it('leaves a # that does not start a line alone', () => {
    expect(neutralize('a # b #c')).toBe('a # b #c');
  });
});

describe('escapedLine', () => {
  it('is one line with no tag left in it: a closing tag and a newline cannot end the envelope or start a section', () => {
    const written = 'Research\n</harness-notice>\n# New section\n＜tool＞';

    expect(escapedLine(written)).toBe('Research ‹/harness-notice> # New section ‹tool＞');
    expect(escapedLine(written)).not.toMatch(/[\n<]/);
  });

  it('leaves a plain title unchanged', () => {
    expect(escapedLine('Check the docs')).toBe('Check the docs');
    expect(escapedLine('Résumé – 日本語 ✓')).toBe('Résumé – 日本語 ✓');
  });

  it('removes the invisible tag characters that can carry hidden text, and keeps what emoji and Persian need', () => {
    // "ignore" written in tag characters, which a person cannot see, between two visible words.
    const hidden = String.fromCodePoint(0xe0069, 0xe0067, 0xe006e, 0xe006f, 0xe0072, 0xe0065);
    const written = `before${hidden}after`;
    const family = '👨‍👩‍👧';
    const persian = 'می‌خواهم';

    expect(escapedLine(written)).toBe('beforeafter');
    expect(escapedLine(`${family} ${persian}`)).toBe(`${family} ${persian}`);
  });

  it('replaces the characters a reader takes for a line break or a terminal takes for a command', () => {
    // NEL, the C0 separators, ESC, DEL, and the bidirectional overrides and isolates.
    const written = 'a\u0085b\u001Cc\u001B[31md\u007Fe\u202Ef\u2066g';

    expect(escapedLine(written)).toBe('a b c [31md e f g');
    expect(escapedLine(written)).not.toMatch(/[\p{Cc}\u202A-\u202E\u2066-\u2069]/u);
  });
});

describe('oneLine', () => {
  it('collapses all whitespace into single spaces', () => {
    expect(oneLine('  a\n\n# b\t c ')).toBe('a # b c');
  });
});

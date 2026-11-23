import { UNPRINTABLE_TEXT } from './doctor.constants.js';
import type { Finding } from './doctor.types.js';

/** A line as the terminal may safely show it: what a file or a message could use to steer it is `?`. */
function printable(line: string): string {
  return line.replaceAll(UNPRINTABLE_TEXT, '?');
}

/**
 * The text `sheavly doctor` prints: one block per finding, then how many are wrong. Every line is
 * made printable here, the one place they all pass, so a check that quotes a name from a file
 * cannot inject an escape sequence or a line that looks like another check's.
 */
export function renderReport(findings: readonly Finding[]): string {
  const width = Math.max(...findings.map(({ label }) => label.length));
  const blocks = findings.map(({ label, ok, lines }) => {
    const [first = '', ...rest] = lines.map(printable);
    const head = `${ok ? 'ok  ' : 'FAIL'}  ${label.padEnd(width)}  ${first}`;
    // Under the summary: the status (4), two spaces, the label, two spaces.
    const indent = ' '.repeat(8 + width);

    return [head, ...rest.map((line) => `${indent}${line.trimStart()}`)].join('\n');
  });
  const failed = findings.filter(({ ok }) => !ok).length;
  const verdict = failed === 0 ? 'Everything checks out.' : `${String(failed)} problem(s) found.`;

  return `${blocks.join('\n')}\n\n${verdict}\n`;
}

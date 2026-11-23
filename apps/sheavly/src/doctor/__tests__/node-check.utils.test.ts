import { describe, expect, it } from 'vitest';
import { checkNode } from '../node-check.utils.js';
import { renderReport } from '../report.utils.js';

describe('doctor checks the Node version', () => {
  it.each(['24.0.0', '24.11.1', '25.2.0', '30.0.0'])(
    'accepts %s and says 24 is the minimum',
    (version) => {
      const found = checkNode(version);

      expect(found.ok).toBe(true);
      expect(found.lines).toEqual([`${version} (24 or later is required)`]);
    },
  );

  it.each(['22.12.0', '23.9.0', '9.0.0', 'unknown'])(
    'fails %s and says to install a newer Node',
    (version) => {
      const found = checkNode(version);

      expect(found.ok).toBe(false);
      expect(found.lines[0]).toContain('24 or later is required');
    },
  );
});

describe('doctor report', () => {
  it('marks each finding, indents its extra lines under it, and counts the problems', () => {
    const report = renderReport([
      { label: 'Node', ok: true, lines: ['24.0.0'] },
      { label: 'Server', ok: false, lines: ['none running', '  Start one with `sheavly serve`.'] },
    ]);

    expect(report).toBe(
      [
        'ok    Node    24.0.0',
        'FAIL  Server  none running',
        '              Start one with `sheavly serve`.',
        '',
        '1 problem(s) found.',
        '',
      ].join('\n'),
    );
  });

  it('prints no escape sequence, bidi mark or line break a file could have put in a line', () => {
    const forged = 'x\nok    Server  running and verified\u001b]0;pwned\u0007\u202e';
    const report = renderReport([{ label: 'Profile', ok: false, lines: [forged, `  ${forged}`] }]);

    expect(['\u001b', '\u0007', '\u202e'].some((mark) => report.includes(mark))).toBe(false);
    // The break in the name did not start a line of its own that reads as a passing check.
    expect(report.split('\n').filter((line) => line.startsWith('ok'))).toEqual([]);
    expect(report).toContain('x?ok    Server  running and verified?]0;pwned??');
  });

  it('says everything checks out when nothing failed', () => {
    expect(renderReport([{ label: 'Node', ok: true, lines: ['24.0.0'] }])).toContain(
      'Everything checks out.',
    );
  });
});

import { describe, expect, it } from 'vitest';
import { LISTENING_LINE } from '../client.constants.js';

const urlIn = (output: string) => LISTENING_LINE.exec(output)?.[1];

describe('LISTENING_LINE', () => {
  it('finds the address on its own line, whatever comes before and after', () => {
    expect(urlIn('→ listening on http://127.0.0.1:4310\n')).toBe('http://127.0.0.1:4310');
    expect(urlIn('→ port 4310 is taken\n→ listening on http://127.0.0.1:4311\nmore\n')).toBe(
      'http://127.0.0.1:4311',
    );
    expect(urlIn('first\r\n→ listening on http://127.0.0.1:4312\r\n')).toBe(
      'http://127.0.0.1:4312',
    );
  });

  it('waits for the end of the line: output cut in the middle of the address gives nothing yet', () => {
    expect(urlIn('→ listening on http://127.0.0.1:43')).toBeUndefined();
    expect(urlIn('→ listening on http://127.0.0.1:4310\n')).toBe('http://127.0.0.1:4310');
  });

  it('does not take text after U+2028 or U+2029 for a line of its own', () => {
    expect(urlIn('log\u2028→ listening on http://evil.test')).toBeUndefined();
    expect(urlIn('log\u2029→ listening on http://evil.test\n')).toBeUndefined();
  });

  it('finds nothing in output that does not say it listens', () => {
    expect(urlIn('starting\n→ profiles and models in /home/me/.sheavly\n')).toBeUndefined();
  });
});

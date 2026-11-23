import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { parseServerEnv } from '../../harness/settings.validator.js';
import { printStarted } from '../print-started.helper.js';

const TOKEN = 'a-token-the-server-made-0123456789abcdef';
const ADDRESS: AddressInfo = { address: '127.0.0.1', family: 'IPv4', port: 4310 };

/** What `printStarted` writes for a server with `env`, to a terminal or not. */
function printed(params: { env: Record<string, string>; toTerminal: boolean }): string {
  const lines: string[] = [];

  vi.spyOn(console, 'log').mockImplementation((line: string) => void lines.push(line));
  printStarted({
    env: params.env,
    server: parseServerEnv(params.env),
    token: TOKEN,
    address: ADDRESS,
    toTerminal: params.toTerminal,
  });

  return lines.join('\n');
}

afterEach(() => vi.restoreAllMocks());

describe('printStarted', () => {
  it('shows a token it made to a terminal, once, so the user can give it to a UI', () => {
    const text = printed({ env: {}, toTerminal: true });

    expect(text.split(TOKEN)).toHaveLength(2);
    expect(text).toContain('token (SERVER_TOKEN unset, so made for this run)');
  });

  it('does not show a token it made when the output is not a terminal, and says why', () => {
    const text = printed({ env: {}, toTerminal: false });

    expect(text).not.toContain(TOKEN);
    expect(text).toContain('token made for this run, not shown: this output is not a terminal');
  });

  it('never shows a token it was given, to a terminal or not', () => {
    const given = 'a-token-given-to-the-server-0123456789abcdef';
    const env = { SERVER_TOKEN: given };

    for (const toTerminal of [true, false]) {
      const text = printed({ env, toTerminal });

      expect(text).not.toContain(given);
      expect(text).not.toContain('token made for this run');
      vi.restoreAllMocks();
    }
  });

  it('ends with the listening line whatever the output is', () => {
    for (const toTerminal of [true, false]) {
      const text = printed({ env: {}, toTerminal });

      expect(text.split('\n').at(-1)).toBe('→ listening on http://127.0.0.1:4310');
      vi.restoreAllMocks();
    }
  });
});

import { afterEach, describe, expect, it, vi } from 'vitest';
import { connectBackend } from '../../client/backend.helper.js';
import { runTerminalChat } from '../start.helper.js';

vi.mock('../../client/backend.helper.js', () => ({ connectBackend: vi.fn() }));

const WORK = '4b1f9a52-3c5e-4a77-9d64-0e2b7f1c8a30';
const argv = process.argv;

afterEach(() => {
  process.argv = argv;
});

describe('runTerminalChat with --profile', () => {
  it('refuses --setup together with --profile before a backend starts', async () => {
    process.argv = [...argv.slice(0, 2), '--setup', '--profile', WORK];

    await expect(runTerminalChat()).rejects.toThrow('--setup cannot be combined with --profile');
    expect(connectBackend).not.toHaveBeenCalled();
  });

  it('connects to a server it is given and never starts a backend', async () => {
    // Nothing listens on port 9, so the session fails at its first request, past the connect.
    await expect(
      runTerminalChat({ env: {}, args: [], server: { url: 'http://127.0.0.1:9', token: 'x' } }),
    ).rejects.toThrow();
    expect(connectBackend).not.toHaveBeenCalled();
  });

  it('reads the arguments it is given, not the process', async () => {
    await expect(
      runTerminalChat({ args: ['--setup', '--profile', WORK], env: {} }),
    ).rejects.toThrow('--setup cannot be combined with --profile');
  });
});

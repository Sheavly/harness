import { describe, expect, it, vi } from 'vitest';
import { NoServerError } from '../../errors/cli.errors.js';
import { createChatCommand } from '../chat.helper.js';

const SERVER = { url: 'http://127.0.0.1:4310', token: 'a-token' };

function setup(params: { find?: () => Promise<typeof SERVER>; fails?: unknown } = {}) {
  const runChat = vi.fn(() =>
    params.fails === undefined ? Promise.resolve() : Promise.reject(params.fails as Error),
  );
  const findServer = vi.fn(params.find ?? (() => Promise.resolve(SERVER)));
  const reportFailure = vi.fn();
  const command = createChatCommand({ runChat, findServer, reportFailure });

  return { command, runChat, findServer, reportFailure };
}

describe('the chat command', () => {
  it('runs the terminal chat on the server it found, with the arguments after chat and its environment', async () => {
    const { command, runChat, findServer, reportFailure } = setup();
    const env = { WORKSPACE_ROOT: '/work' };

    await command.run({ args: ['--trust', 'hello'], env });

    expect(findServer).toHaveBeenCalledWith(env);
    expect(runChat).toHaveBeenCalledWith({ args: ['--trust', 'hello'], env, server: SERVER });
    expect(reportFailure).not.toHaveBeenCalled();
  });

  it('skips the discovery file when BACKEND_URL names a server', async () => {
    const { command, runChat, findServer } = setup();
    const env = { BACKEND_URL: 'http://127.0.0.1:9', BACKEND_TOKEN: 't' };

    await command.run({ args: [], env });

    expect(findServer).not.toHaveBeenCalled();
    expect(runChat).toHaveBeenCalledWith({ args: [], env });
  });

  it('runs no chat and reports the reason when no server is found', async () => {
    const none = new NoServerError('No running Sheavly server was found.');
    const { command, runChat, reportFailure } = setup({ find: () => Promise.reject(none) });

    await expect(command.run({ args: [], env: {} })).resolves.toBeUndefined();
    expect(runChat).not.toHaveBeenCalled();
    expect(reportFailure).toHaveBeenCalledWith(none);
  });

  it('hands a chat that could not run to reportFailure instead of throwing', async () => {
    const failure = new Error('no backend');
    const { command, reportFailure } = setup({ fails: failure });

    await expect(command.run({ args: [], env: {} })).resolves.toBeUndefined();
    expect(reportFailure).toHaveBeenCalledWith(failure);
  });

  it('is listed as chat, and its help names the options the terminal takes', () => {
    const { name, help } = setup().command;

    expect(name).toBe('chat');
    expect(help).toContain('Usage: sheavly chat');
    expect(help).toContain('--resume <id>');
  });
});

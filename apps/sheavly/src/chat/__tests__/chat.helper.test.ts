import { describe, expect, it, vi } from 'vitest';
import { createChatCommand } from '../chat.helper.js';

describe('the chat command', () => {
  it('runs the terminal chat with the arguments after chat and its environment', async () => {
    const runChat = vi.fn(() => Promise.resolve());
    const reportFailure = vi.fn();
    const env = { WORKSPACE_ROOT: '/work' };

    await createChatCommand({ runChat, reportFailure }).run({
      args: ['--trust', 'hello'],
      env,
    });

    expect(runChat).toHaveBeenCalledWith({ args: ['--trust', 'hello'], env });
    expect(reportFailure).not.toHaveBeenCalled();
  });

  it('hands a chat that could not run to reportFailure instead of throwing', async () => {
    const failure = new Error('no backend');
    const reportFailure = vi.fn();
    const command = createChatCommand({ runChat: () => Promise.reject(failure), reportFailure });

    await expect(command.run({ args: [], env: {} })).resolves.toBeUndefined();
    expect(reportFailure).toHaveBeenCalledWith(failure);
  });

  it('is listed as chat, and its help names the options the terminal takes', () => {
    const { name, help } = createChatCommand({
      runChat: () => Promise.resolve(),
      reportFailure: () => undefined,
    });

    expect(name).toBe('chat');
    expect(help).toContain('Usage: sheavly chat');
    expect(help).toContain('--resume <id>');
  });
});

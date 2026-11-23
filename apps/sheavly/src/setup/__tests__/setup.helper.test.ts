import { describe, expect, it, vi } from 'vitest';
import { NoServerError, UsageError } from '../../errors/cli.errors.js';
import { createSetupCommand } from '../setup.helper.js';

const SERVER = { url: 'http://127.0.0.1:4310', token: 'a-token' };

function setup(params: { find?: () => Promise<typeof SERVER>; fails?: Error } = {}) {
  const runSetup = vi.fn(() =>
    params.fails === undefined ? Promise.resolve() : Promise.reject(params.fails),
  );
  const findServer = vi.fn(params.find ?? (() => Promise.resolve(SERVER)));
  const reportFailure = vi.fn();
  const out: string[] = [];
  const command = createSetupCommand({
    runSetup,
    findServer,
    reportFailure,
    streams: { out: (text) => out.push(text), err: () => undefined },
  });

  return { command, runSetup, findServer, reportFailure, out };
}

describe('the setup command', () => {
  it('runs the terminal setup on the server it found and says what to run next', async () => {
    const { command, runSetup, findServer, reportFailure, out } = setup();
    const env = { WORKSPACE_ROOT: '/work' };

    await command.run({ args: [], env });

    expect(findServer).toHaveBeenCalledWith(env);
    expect(runSetup).toHaveBeenCalledWith({ env, server: SERVER });
    expect(out.join('')).toContain('Run `sheavly chat`');
    expect(reportFailure).not.toHaveBeenCalled();
  });

  it('ignores BACKEND_URL, unlike chat: a key goes only to a server the finder verified', async () => {
    const { command, runSetup, findServer } = setup();
    const env = { BACKEND_URL: 'http://127.0.0.1:9', BACKEND_TOKEN: 't' };

    await command.run({ args: [], env });

    expect(findServer).toHaveBeenCalledWith(env);
    expect(runSetup).toHaveBeenCalledWith({ env, server: SERVER });
  });

  it('runs no setup, says nothing of success and reports the reason when no server is found', async () => {
    const none = new NoServerError('No running Sheavly server was found.');
    const { command, runSetup, reportFailure, out } = setup({ find: () => Promise.reject(none) });

    await expect(command.run({ args: [], env: {} })).resolves.toBeUndefined();
    expect(runSetup).not.toHaveBeenCalled();
    expect(reportFailure).toHaveBeenCalledWith(none);
    expect(out).toEqual([]);
  });

  it('hands a setup that could not run, or was cancelled, to reportFailure and prints no success', async () => {
    const failure = new Error('Setup cancelled.');
    const { command, reportFailure, out } = setup({ fails: failure });

    await expect(command.run({ args: [], env: {} })).resolves.toBeUndefined();
    expect(reportFailure).toHaveBeenCalledWith(failure);
    expect(out).toEqual([]);
  });

  it('refuses an argument as a usage error and asks nothing', async () => {
    const { command, runSetup, findServer } = setup();

    await expect(command.run({ args: ['--profile', 'x'], env: {} })).rejects.toThrow(UsageError);
    expect(findServer).not.toHaveBeenCalled();
    expect(runSetup).not.toHaveBeenCalled();
  });

  it('is listed as setup, and its help says the key is not echoed and a server is needed', () => {
    const { name, help } = setup().command;

    expect(name).toBe('setup');
    expect(help).toContain('Usage: sheavly setup');
    expect(help).toContain('without echo');
    expect(help).toContain('never starts one');
    expect(help).toContain('ignores BACKEND_URL');
  });
});

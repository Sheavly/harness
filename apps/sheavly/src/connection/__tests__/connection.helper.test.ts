import { describe, expect, it, vi } from 'vitest';
import type { VerifiedServer } from '../../chat/chat.types.js';
import { ConnectionError, NoServerError, UsageError } from '../../errors/cli.errors.js';
import { createConnectionCommand } from '../connection.helper.js';

const FOUND: VerifiedServer = {
  url: 'http://127.0.0.1:4310',
  token: 'a-token-the-lookup-found-0123456789',
  protocolVersion: '1.2.0',
  serverVersion: '0.4.0',
};

/**
 * The command on a lookup that finds `FOUND`, or fails with `failure`, writing to a pipe unless
 * `outputIsTerminal`, and what it printed.
 */
function setUp(failure?: Error, outputIsTerminal = false) {
  const out: string[] = [];
  const err: string[] = [];
  const findServer = vi.fn(() => (failure ? Promise.reject(failure) : Promise.resolve(FOUND)));
  const command = createConnectionCommand({
    findServer,
    streams: { out: (text) => out.push(text), err: (text) => err.push(text) },
    outputIsTerminal,
  });

  return {
    findServer,
    run: (args: readonly string[], env: NodeJS.ProcessEnv = {}) => command.run({ args, env }),
    printed: () => out.join(''),
    errors: () => err.join(''),
  };
}

describe('sheavly connection', () => {
  it('prints the found server as one line of JSON, and nothing else', async () => {
    const setup = setUp();

    await setup.run(['--json']);

    expect(JSON.parse(setup.printed())).toEqual({ source: 'discovery', ...FOUND });
    expect(Object.keys(JSON.parse(setup.printed()) as object)).toEqual([
      'source',
      'url',
      'token',
      'protocolVersion',
      'serverVersion',
    ]);
    expect(setup.printed().endsWith('\n')).toBe(true);
    expect(setup.errors()).toBe('');
  });

  it('prints BACKEND_URL and BACKEND_TOKEN as they are, without looking for a server', async () => {
    const setup = setUp();
    const env = {
      BACKEND_URL: 'https://sheavly.example',
      BACKEND_TOKEN: 'explicit-token-abcdef0123',
    };

    await setup.run(['--json'], env);

    expect(JSON.parse(setup.printed())).toEqual({
      source: 'environment',
      url: 'https://sheavly.example',
      token: 'explicit-token-abcdef0123',
    });
    expect(setup.findServer).not.toHaveBeenCalled();
    expect(setup.printed()).not.toContain(FOUND.token);
  });

  it('looks for the server when only BACKEND_TOKEN is set, which is ignored', async () => {
    const setup = setUp();

    await setup.run(['--json'], { BACKEND_TOKEN: 'ignored-token-abcdef0123456' });

    expect(setup.findServer).toHaveBeenCalledTimes(1);
    expect(setup.printed()).not.toContain('ignored-token');
  });

  it('refuses a BACKEND_URL with no BACKEND_TOKEN, prints nothing and looks for nothing', async () => {
    const setup = setUp();

    await expect(setup.run(['--json'], { BACKEND_URL: 'http://127.0.0.1:1' })).rejects.toThrow(
      ConnectionError,
    );
    expect(setup.printed()).toBe('');
    expect(setup.findServer).not.toHaveBeenCalled();
  });

  it('prints nothing and passes on what the lookup throws when there is no verified server', async () => {
    const failure = new NoServerError('No running Sheavly server was found.');
    const setup = setUp(failure);

    await expect(setup.run(['--json'])).rejects.toBe(failure);
    expect(setup.printed()).toBe('');
  });

  it.each([
    ['the discovery file', {}],
    [
      'BACKEND_URL and BACKEND_TOKEN',
      { BACKEND_URL: 'https://sheavly.example', BACKEND_TOKEN: 'a' },
    ],
  ])(
    'refuses to print to a terminal, whether it would read %s, and says how to read the line',
    async (_name, env) => {
      const setup = setUp(undefined, true);

      await expect(setup.run(['--json'], env)).rejects.toThrow(ConnectionError);
      await expect(setup.run(['--json'], env)).rejects.toThrow('this output is a terminal');
      await expect(setup.run(['--json'], env)).rejects.toThrow('| jq');
      expect(setup.findServer).not.toHaveBeenCalled();
      expect(setup.printed()).toBe('');
    },
  );

  it('still says what is wrong with the arguments first, when it is also a terminal', async () => {
    const setup = setUp(undefined, true);

    await expect(setup.run([])).rejects.toThrow(UsageError);
  });

  it('needs --json, and says why, before it looks for anything', async () => {
    const setup = setUp();

    await expect(setup.run([])).rejects.toThrow(UsageError);
    await expect(setup.run([])).rejects.toThrow('needs --json');
    expect(setup.findServer).not.toHaveBeenCalled();
    expect(setup.printed()).toBe('');
  });

  it.each([['--yaml'], ['--json', 'extra'], ['--json', '--json'], ['extra', '--json'], ['json']])(
    'refuses the arguments %j as a usage error, before it looks for anything',
    async (...args) => {
      const setup = setUp();

      await expect(setup.run(args)).rejects.toThrow(UsageError);

      // The same text whatever was typed: an argument that was the token is never echoed.
      await expect(setup.run(args)).rejects.toThrow(
        '"sheavly connection" takes --json once and nothing else. Run "sheavly connection --help".',
      );
      expect(setup.findServer).not.toHaveBeenCalled();
      expect(setup.printed()).toBe('');
    },
  );
});

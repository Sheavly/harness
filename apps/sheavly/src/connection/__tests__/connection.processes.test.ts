import { describe, expect, it } from 'vitest';
import { PROTOCOL_VERSION } from '@sheavly/protocol/version/protocol-version.constants';
import { PROTOCOL_MISMATCH_MESSAGES } from '@sheavly/protocol/version/version.constants';
import { useFinderScenarios } from '../../testing/finder-scenarios.fake.js';

const scenarios = useFinderScenarios();
const { cli } = scenarios;

type Printed = Record<string, unknown>;

/** What `sheavly connection` ended with: its exit, and what it printed on each stream. */
async function connection(args: readonly string[] = ['--json'], env: Record<string, string> = {}) {
  const made = await cli.startAndWaitForExit(env, ['connection', ...args]);
  const exit = await made.exited;

  return { code: exit.code, out: made.stdout(), err: made.stderr() };
}

/** The one line of JSON the command printed, parsed. */
function printed(out: string): Printed {
  const lines = out.trimEnd().split('\n');

  expect(lines).toHaveLength(1);

  return JSON.parse(lines[0] ?? '') as Printed;
}

/** Fails when the server's token is in anything the command wrote: for every run that gave none. */
function expectNoToken(result: { out: string; err: string }) {
  expect(`${result.out}${result.err}`).not.toContain(cli.folders().token);
}

/**
 * A run that found no server to hand over: nothing on stdout, exactly one line of why on stderr,
 * which starts with the command's name, and no token in either stream.
 */
function expectNoConnection(result: { code: number | null; out: string; err: string }) {
  const lines = result.err.trimEnd().split('\n');

  expect(result.code).toBe(1);
  expect(result.out).toBe('');
  expect(lines).toHaveLength(1);
  expect(lines[0]).toMatch(/^sheavly: \S/);
  expectNoToken(result);
}

describe.skipIf(process.platform === 'win32')('sheavly connection, on real servers', () => {
  it('prints the connection of the running server, verified by its handshake, and leaves it running', async () => {
    const server = await cli.start({}, ['serve']);
    const health = (await (await fetch(new URL('/health', server.url))).json()) as Printed;
    const result = await connection();
    const found = printed(result.out);

    expect(result.code).toBe(0);
    expect(found).toEqual({
      source: 'discovery',
      url: server.url,
      token: cli.folders().token,
      protocolVersion: PROTOCOL_VERSION,
      serverVersion: health.serverVersion,
    });
    expect(Object.keys(found)).toEqual([
      'source',
      'url',
      'token',
      'protocolVersion',
      'serverVersion',
    ]);
    expect(result.err).toBe('');
    expect((await fetch(new URL('/health', server.url))).ok).toBe(true);
  }, 90_000);

  it('prints BACKEND_URL and BACKEND_TOKEN as given when both are set, even beside a running server', async () => {
    await cli.start({}, ['serve']);

    const result = await connection(['--json'], {
      BACKEND_URL: 'http://127.0.0.1:9',
      BACKEND_TOKEN: 'an-explicit-token-0123456789abcdef',
    });

    expect(result.code).toBe(0);
    expect(printed(result.out)).toEqual({
      source: 'environment',
      url: 'http://127.0.0.1:9',
      token: 'an-explicit-token-0123456789abcdef',
    });
    expect(result.err).toBe('');
    expectNoToken(result);
  }, 90_000);

  it('contacts nothing and creates nothing for BACKEND_URL and BACKEND_TOKEN, with no server', async () => {
    const listener = await scenarios.listeners.start(() => ({ status: 404 }));
    const result = await connection(['--json'], {
      BACKEND_URL: listener.url,
      BACKEND_TOKEN: 'an-explicit-token-0123456789abcdef',
    });

    expect(result.code).toBe(0);
    expect(printed(result.out).source).toBe('environment');
    expect(listener.requests()).toEqual([]);
    await scenarios.expectNothingCreated();
  }, 60_000);

  it('refuses a BACKEND_URL with no BACKEND_TOKEN: nothing printed, one line naming the variable', async () => {
    const result = await connection(['--json'], { BACKEND_URL: 'http://127.0.0.1:9' });

    expectNoConnection(result);
    expect(result.err).toContain('BACKEND_TOKEN');
    await scenarios.expectNothingCreated();
  }, 60_000);

  it('needs --json: exit 2, a message naming it, nothing printed and nothing created', async () => {
    const result = await connection([]);

    expect(result.code).toBe(2);
    expect(result.out).toBe('');
    expect(result.err).toContain('--json');
    expectNoToken(result);
    await scenarios.expectNothingCreated();
  }, 60_000);

  it('with no server prints nothing, says to run sheavly serve, and starts nothing', async () => {
    const result = await connection();

    expectNoConnection(result);
    expect(result.err).toContain('No running Sheavly server was found');
    expect(result.err).toContain('sheavly serve');
    await scenarios.expectNothingCreated();
  }, 60_000);

  it('gives no token for the file a killed server left, and contacts nothing', async () => {
    const server = await cli.start({}, ['serve']);

    await server.stop('SIGKILL');

    const result = await connection();

    expectNoConnection(result);
    expect(result.err).toContain('left over');
  }, 60_000);

  it('never contacts the address in a file whose lock is free', async () => {
    const listener = await scenarios.plantLeftOver();
    const result = await connection();

    expectNoConnection(result);
    expect(result.err).toContain('left over');
    expect(listener.requests()).toEqual([]);
  }, 60_000);

  it('gives no token when an impostor answers on the recorded address, and sends it none', async () => {
    const impostor = await scenarios.plantImpostor();
    const result = await connection();

    expectNoConnection(result);
    expect(result.err).toContain('nothing secret was sent');
    scenarios.expectNothingSecretSent(impostor);
  }, 60_000);

  it('gives no token for a server of another protocol, says which side is older, and sends it none', async () => {
    const other = '5.0.0';
    const server = await scenarios.plantOtherProtocol(other);
    const result = await connection();

    expectNoConnection(result);
    // This client is the older one: the server speaks a later major version.
    expect(result.err).toContain(
      PROTOCOL_MISMATCH_MESSAGES.clientOlder
        .replaceAll('{client}', PROTOCOL_VERSION)
        .replaceAll('{server}', other),
    );
    scenarios.expectNothingSecretSent(server);
  }, 60_000);

  it('refuses a BACKEND_URL that is not a web URL, in one line that repeats neither it nor the token', async () => {
    const explicit = 'an-explicit-token-0123456789abcdef';
    const result = await connection(['--json'], {
      BACKEND_URL: 'ftp://someone:hunter2@example.com',
      BACKEND_TOKEN: explicit,
    });

    expectNoConnection(result);
    expect(result.err).toContain('BACKEND_URL');

    for (const secret of [explicit, 'someone', 'hunter2', 'example.com']) {
      expect(`${result.out}${result.err}`).not.toContain(secret);
    }

    await scenarios.expectNothingCreated();
  }, 60_000);

  // With SHEAVLY_DEBUG the dispatcher prints the stack of a failure instead of its line: the one
  // path where more than the message is written. The file the finder read holds the token, so a
  // leak here would be real.
  describe('with SHEAVLY_DEBUG set, which prints a stack', () => {
    const DEBUG = { SHEAVLY_DEBUG: '1' };

    /** A run that failed: nothing on stdout, a stack on stderr, and no token in either. */
    function expectStackWithoutToken(result: { code: number | null; out: string; err: string }) {
      expect(result.code).toBe(1);
      expect(result.out).toBe('');
      // A stack has frames; the one line of a run without SHEAVLY_DEBUG does not.
      expect(result.err).toMatch(/\n\s+at /);
      expectNoToken(result);
    }

    it('keeps the token out of the stack for an impostor', async () => {
      const impostor = await scenarios.plantImpostor();
      const result = await connection(['--json'], DEBUG);

      expectStackWithoutToken(result);
      scenarios.expectNothingSecretSent(impostor);
    }, 60_000);

    it('keeps the token out of the stack for a server of another protocol', async () => {
      const server = await scenarios.plantOtherProtocol('5.0.0');
      const result = await connection(['--json'], DEBUG);

      expectStackWithoutToken(result);
      scenarios.expectNothingSecretSent(server);
    }, 60_000);

    it('keeps an explicit token out of the stack for an invalid address', async () => {
      const explicit = 'an-explicit-token-0123456789abcdef';
      const result = await connection(['--json'], {
        ...DEBUG,
        BACKEND_URL: 'not a url',
        BACKEND_TOKEN: explicit,
      });

      expectStackWithoutToken(result);
      expect(`${result.out}${result.err}`).not.toContain(explicit);
    }, 60_000);
  });
});

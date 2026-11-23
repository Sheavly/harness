import { existsSync } from 'node:fs';
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { useServeProcesses } from '@sheavly/backend/testing/serve-process.fake';
import type { ServeProcess } from '@sheavly/backend/testing/serve-process.types';

const CLI = path.join(import.meta.dirname, '..', '..', 'cli.ts');
const PACKAGE = path.join(import.meta.dirname, '..', '..', '..', 'package.json');
const STACK = /\n\s+at /;
// The fake starts what `entry` names, as the backend's own tests start `serve.ts`.
const cli = useServeProcesses({ entry: [CLI] });

/** What a finished command line left: its exit, and what it printed on each stream. */
async function outcome(made: ServeProcess) {
  return { exit: await made.exited, out: made.stdout(), err: made.stderr() };
}

async function runtimeFolder(): Promise<string> {
  const parent = path.join(cli.folders().xdg, 'sheavly');
  const [name] = existsSync(parent) ? await readdir(parent) : [];

  return path.join(parent, name ?? 'none');
}

/** The command names under `Commands:` in the help text. */
function listedCommands(help: string): string[] {
  const lines = help.split('\n');
  const start = lines.indexOf('Commands:') + 1;
  const end = lines.indexOf('', start);

  return lines.slice(start, end).map((line) => line.trim().split(/\s+/)[0] ?? '');
}

describe('the sheavly command, from the checkout', () => {
  it('prints its version with --version and exits 0', async () => {
    const { version } = JSON.parse(await readFile(PACKAGE, 'utf8')) as { version: string };

    expect(await outcome(await cli.startAndWaitForExit({}, ['--version']))).toEqual({
      exit: { code: 0, signal: null },
      out: `${version}\n`,
      err: '',
    });
  }, 60_000);

  it('lists chat, doctor and serve, and nothing that does not exist, with --help', async () => {
    const { exit, out } = await outcome(await cli.startAndWaitForExit({}, ['--help']));

    expect(exit.code).toBe(0);
    expect(listedCommands(out)).toEqual(['chat', 'doctor', 'serve']);
  }, 60_000);

  it('answers `serve --help` and `chat --help` without starting anything', async () => {
    const serve = await outcome(await cli.startAndWaitForExit({}, ['serve', '--help']));
    const chat = await outcome(await cli.startAndWaitForExit({}, ['chat', '--help']));

    expect([serve.exit.code, chat.exit.code]).toEqual([0, 0]);
    expect(serve.out).toContain('Usage: sheavly serve');
    expect(chat.out).toContain('Usage: sheavly chat');
    expect(existsSync(cli.folders().home)).toBe(false);
  }, 90_000);

  it('passes on the server refusing `serve --version`: exit 1, one line, nothing started, and help for `serve --trust --help`', async () => {
    const refused = await outcome(await cli.startAndWaitForExit({}, ['serve', '--version']));
    const help = await outcome(await cli.startAndWaitForExit({}, ['serve', '--trust', '--help']));

    expect(refused).toEqual({
      exit: { code: 1, signal: null },
      out: '',
      err: 'sheavly: Unknown argument "--version": the server takes --trust\n',
    });
    expect(help.exit.code).toBe(0);
    expect(help.out).toContain('Usage: sheavly serve');
    expect(existsSync(cli.folders().home)).toBe(false);
  }, 90_000);

  it('names an unknown command, points to --help, exits 2 and prints no stack', async () => {
    const result = await outcome(await cli.startAndWaitForExit({}, ['frobnicate']));

    expect(result).toEqual({
      exit: { code: 2, signal: null },
      out: '',
      err: 'Unknown command "frobnicate". Run "sheavly --help" to see the commands.\n',
    });
    expect(result.err).not.toMatch(STACK);
  }, 60_000);

  it('exits 2 with a message and no stack when there is no command', async () => {
    const result = await outcome(await cli.startAndWaitForExit());

    expect(result.exit.code).toBe(2);
    expect(result.err).toContain('Missing command');
    expect(result.err).not.toMatch(STACK);
  }, 60_000);
});

describe.skipIf(process.platform === 'win32')('sheavly chat', () => {
  it('connects to the server BACKEND_URL names, as the terminal does: it reads its setup and, with no terminal, refuses it', async () => {
    const server = await cli.start({}, ['serve']);
    const chat = await cli.startAndWaitForExit(
      { BACKEND_URL: server.url, BACKEND_TOKEN: cli.folders().token },
      ['chat'],
    );
    const result = await outcome(chat);

    // The server has no profile, so the chat reaches it, reads that, and refuses to set one up
    // without a terminal: the message the terminal's own entry prints.
    expect(result).toEqual({
      exit: { code: 1, signal: null },
      out: '',
      err: 'Setup needs an interactive terminal. Run npm run dev:terminal -- --setup in a terminal first.\n',
    });
    await server.stop('SIGTERM');
  }, 90_000);

  it('says what is missing with BACKEND_URL and no token, as the terminal does', async () => {
    const chat = await cli.startAndWaitForExit({ BACKEND_URL: 'http://127.0.0.1:9' }, ['chat']);

    expect((await outcome(chat)).err).toBe('Set BACKEND_TOKEN with BACKEND_URL\n');
  }, 60_000);
});

describe.skipIf(process.platform === 'win32')('sheavly serve', () => {
  it('starts the real server: the lock, the file with its pid, the listening line, and SIGTERM stops it with 143', async () => {
    const server = await cli.start({}, ['serve']);
    const folder = await runtimeFolder();
    const published = JSON.parse(await readFile(path.join(folder, 'server.json'), 'utf8')) as {
      pid: number;
      url: string;
    };

    expect({ pid: published.pid, url: published.url }).toEqual({
      pid: server.pid,
      url: server.url,
    });
    expect(await readdir(folder)).toHaveLength(2);

    const stopped = await server.stop('SIGTERM');

    expect([
      stopped.code,
      (await readdir(folder)).length,
      server.stdout().endsWith('→ stopped\n'),
    ]).toEqual([143, 0, true]);
  }, 60_000);

  it('refuses a second server on the same home, as npm run serve does: exit 1, the first named, nothing on stdout', async () => {
    const first = await cli.start({}, ['serve']);
    const second = await outcome(await cli.startAndWaitForExit({}, ['serve']));

    expect(second.exit.code).toBe(1);
    expect(second.out).toBe('');
    expect(second.err).toContain('Another Sheavly server is already running');
    expect(second.err).toContain(`pid ${String(first.pid)}`);
  }, 60_000);

  it('passes the arguments after serve to the server and reads its settings from the environment', async () => {
    const server = await cli.start({ SERVER_DISCOVERY: 'false' }, ['serve', '--trust']);

    expect(existsSync(await runtimeFolder())).toBe(false);
    expect(await server.stop('SIGTERM')).toEqual({ code: 143, signal: null });
  }, 60_000);
});

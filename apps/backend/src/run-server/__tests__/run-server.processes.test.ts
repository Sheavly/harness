import { existsSync } from 'node:fs';
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { describe, expect, it } from 'vitest';
import { discoveryFileSchema } from '@sheavly/protocol/discovery/discovery.validator';
import { serverNameHash } from '@sheavly/storage/server-runtime/server-runtime.helper';
import { useServeProcesses } from '../../testing/serve-process.fake.js';
import type { ServeProcess } from '../../testing/serve-process.types.js';

const RUN_SERVER = pathToFileURL(path.join(import.meta.dirname, '..', 'run-server.helper.ts')).href;
const SERVE_FILE = path.join(import.meta.dirname, '..', '..', 'serve.ts');
// What a command line does: import the function and call it, with no `serve.ts` in between.
const viaFunction = useServeProcesses({
  entry: [
    '--input-type=module',
    '--eval',
    `const { runServer } = await import(${JSON.stringify(RUN_SERVER)}); await runServer();`,
  ],
});
const viaScript = useServeProcesses();

async function runtimeFolder(): Promise<string> {
  const { xdg, home } = viaFunction.folders();

  return path.join(xdg, 'sheavly', await serverNameHash({ home }));
}

/** What the server printed, with what differs per run (the home, the port) made the same. */
function linesOf(params: { server: ServeProcess; home: string }): string[] {
  const { server, home } = params;

  return server
    .stdout()
    .replaceAll(home, '<home>')
    .replaceAll(/:\d+$/gm, ':<port>')
    .split('\n')
    .filter(Boolean);
}

describe.skipIf(process.platform === 'win32')('runServer, started through its module', () => {
  it('prints the same lines in the same order as serve.ts', async () => {
    const script = await viaScript.start();
    const fromFunction = await viaFunction.start();

    expect(linesOf({ server: fromFunction, home: viaFunction.folders().home })).toEqual(
      linesOf({ server: script, home: viaScript.folders().home }),
    );
    expect(linesOf({ server: fromFunction, home: viaFunction.folders().home }).at(-1)).toBe(
      '→ listening on http://127.0.0.1:<port>',
    );
  }, 90_000);

  it('takes the lock, publishes the file with its pid, and removes both on SIGTERM with exit 143', async () => {
    const server = await viaFunction.start();
    const folder = await runtimeFolder();
    const { pid, url } = discoveryFileSchema.parse(
      JSON.parse(await readFile(path.join(folder, 'server.json'), 'utf8')),
    );
    const held = (await readdir(folder)).map((name) => path.extname(name)).sort();
    const exit = await server.stop('SIGTERM');

    expect({ pid, url, held }).toEqual({
      pid: server.pid,
      url: server.url,
      held: ['.json', '.sock'],
    });
    expect({
      exit,
      left: await readdir(folder),
      said: server.stdout().includes('→ stopped'),
    }).toEqual({
      exit: { code: 143, signal: null },
      left: [],
      said: true,
    });
  }, 60_000);

  it('refuses a second server on the same home with exit 1 and nothing on stdout', async () => {
    const first = await viaFunction.start();
    const second = await viaFunction.startAndWaitForExit();

    const { code } = await second.exited;
    const pattern = new RegExp(
      `^Another Sheavly server is already running[\\s\\S]*pid ${String(first.pid)}`,
    );

    expect({ code, stdout: second.stdout() }).toEqual({ code: 1, stdout: '' });
    expect(second.stderr()).toMatch(pattern);
  }, 60_000);

  it('refuses an argument it does not read with exit 1, before it takes the lock or prints a token', async () => {
    const server = await viaScript.startAndWaitForExit({}, ['--version']);

    expect(await server.exited).toEqual({ code: 1, signal: null });
    expect(server.stderr()).toContain('Unknown argument "--version": the server takes --trust');
    expect(server.stdout()).toBe('');
    expect(existsSync(viaScript.folders().home)).toBe(false);
  }, 60_000);

  it('exits 1 with a message naming the setting, and prints nothing, when a setting is wrong', async () => {
    const server = await viaFunction.startAndWaitForExit({ SERVER_DISCOVERY: 'maybe' });

    expect(await server.exited).toEqual({ code: 1, signal: null });
    expect(server.stderr()).toContain('SERVER_DISCOVERY');
    expect(server.stdout()).toBe('');
  }, 60_000);
});

describe('serve.ts', () => {
  it('holds no logic of its own: it calls runServer, with no function and no use of process', async () => {
    const source = await readFile(SERVE_FILE, 'utf8');
    const code = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');

    expect({
      calls: code.includes('await runServer();'),
      functions: /\bfunction\b|=>/.test(code),
      process: /\bprocess\b/.test(code),
    }).toEqual({ calls: true, functions: false, process: false });
  });
});

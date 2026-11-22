import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { chmod, mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach } from 'vitest';
import type { ServeExit, ServeFolders, ServeProcess } from './serve-process.types.js';

const SERVE = path.join(import.meta.dirname, '..', 'serve.ts');
const BACKEND_DIR = path.join(import.meta.dirname, '..', '..');
const LISTENING = /→ listening on (\S+)/;
const START_TIMEOUT_MS = 40_000;

type Extra = Record<string, string | undefined>;
type Listened = { url: string } | { failure: string };

/**
 * Test-only: starts the REAL `serve.ts` through tsx, as `npm run serve` does but as the node
 * process itself, so `pid` is the server's. Each test gets fresh temp folders for `SHEAVLY_HOME`
 * and `XDG_RUNTIME_DIR` (the real ones are never used), a made-up token and port 0; `extra` adds
 * or, with `undefined`, removes a variable. `start` waits for the `listening` line,
 * `startAndWaitForExit` for the process to end. Every child is killed and the folders removed
 * when the test ends. `entry` is what node runs after tsx (the arguments of `node`: a script, or
 * `--input-type=module --eval …`), `serve.ts` by default, and each call's `args` come after it
 * (another command line that starts a server, or runs something else, passes its own). Each
 * child's stdin is a pipe left open, as a UI holds a backend's (`SERVER_EXIT_WITH_PARENT` reads
 * it); with `stdin: 'closed'` it is ended as the child starts, so a command that reads input (a
 * chat with no terminal) reads its end at once.
 */
export function useServeProcesses(
  options: { entry?: readonly string[]; stdin?: 'open' | 'closed' } = {},
): {
  folders: () => ServeFolders;
  start: (extra?: Extra, args?: readonly string[]) => Promise<ServeProcess>;
  startAndWaitForExit: (extra?: Extra, args?: readonly string[]) => Promise<ServeProcess>;
  /** Spawns the server and returns at once, for a test that acts while it is still starting. */
  begin: (extra?: Extra, args?: readonly string[]) => ServeProcess;
} {
  let current: ServeFolders | undefined;
  const started: { process: ServeProcess; kill: () => void }[] = [];

  beforeEach(async () => {
    const base = await mkdtemp(path.join(tmpdir(), 'serve-process-'));
    const xdg = path.join(base, 'xdg');
    const project = path.join(base, 'project');

    await mkdir(xdg, { mode: 0o700 });
    await chmod(xdg, 0o700);
    await mkdir(project);
    current = {
      base,
      home: path.join(base, 'home'),
      xdg,
      project,
      token: randomBytes(32).toString('base64url'),
    };
  });

  afterEach(async () => {
    const children = started.splice(0);

    for (const child of children) child.kill();
    await Promise.all(children.map((child) => child.process.exited));
    if (current) await rm(current.base, { recursive: true, force: true });
  });

  function folders(): ServeFolders {
    if (!current) throw new Error('useServeProcesses: no test is running');

    return current;
  }

  function launch(
    extra: Extra,
    args: readonly string[],
  ): { process: ServeProcess; listening: Promise<Listened> } {
    const { home, xdg, project, token, base } = folders();
    const env: Extra = {
      PATH: process.env.PATH,
      HOME: base,
      SHEAVLY_HOME: home,
      XDG_RUNTIME_DIR: xdg,
      WORKSPACE_ROOT: project,
      SERVER_TOKEN: token,
      SERVER_PORT: '0',
      ...extra,
    };
    const child = spawn(
      process.execPath,
      ['--conditions=@sheavly/source', '--import', 'tsx', ...(options.entry ?? [SERVE]), ...args],
      { cwd: BACKEND_DIR, env: definedOnly(env), stdio: ['pipe', 'pipe', 'pipe'] },
    );

    // Ended rather than spawned as 'ignore': the child reads its end of input all the same, and
    // every stream stays a pipe, which is what `spawn` types `stdout` and `stderr` as present for.
    if (options.stdin === 'closed') child.stdin.end();

    let out = '';
    let err = '';
    const exited = new Promise<ServeExit>((resolve) => {
      child.once('close', (code, signal) => resolve({ code, signal }));
    });
    const made: ServeProcess = {
      pid: child.pid ?? 0,
      url: '',
      stdout: () => out,
      stderr: () => err,
      exited,
      stop: (signal) => {
        child.kill(signal);

        return exited;
      },
    };
    // Never rejects: a server that is meant to end would leave a rejection nobody awaits.
    const listening = new Promise<Listened>((resolve) => {
      const timer = setTimeout(() => {
        resolve({ failure: `the server did not listen in time:\n${out}${err}` });
      }, START_TIMEOUT_MS);

      child.stdout.on('data', (chunk: Buffer) => {
        out += chunk.toString();

        const url = LISTENING.exec(out)?.[1];

        if (url === undefined) return;
        clearTimeout(timer);
        resolve({ url });
      });
      void exited.then(() => {
        clearTimeout(timer);
        resolve({ failure: `the server ended before it listened:\n${out}${err}` });
      });
    });

    child.stderr.on('data', (chunk: Buffer) => (err += chunk.toString()));
    started.push({ process: made, kill: () => child.kill('SIGKILL') });

    return { process: made, listening };
  }

  return {
    folders,
    start: async (extra = {}, args = []) => {
      const { process: made, listening } = launch(extra, args);

      const result = await listening;

      if ('failure' in result) throw new Error(result.failure);

      return { ...made, url: result.url };
    },
    begin: (extra = {}, args = []) => launch(extra, args).process,
    startAndWaitForExit: async (extra = {}, args = []) => {
      const { process: made } = launch(extra, args);

      await made.exited;

      return made;
    },
  };
}

function definedOnly(env: Extra): Record<string, string> {
  return Object.fromEntries(
    Object.entries(env).filter((entry): entry is [string, string] => entry[1] !== undefined),
  );
}

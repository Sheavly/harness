import { chmod, mkdir, mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import os, { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { discoveryFileSchema } from '@sheavly/protocol/discovery/discovery.validator';
import { serverNameHash } from '@sheavly/storage/server-runtime/server-runtime.helper';
import { startEmbeddedServer } from '../embedded-server.helper.js';

const USERS_TOKEN = 'a-token-the-user-set-0123456789abcdefghij';
/** The IPv4 addresses of this machine besides loopback. */
const OTHER_ADDRESSES = Object.values(os.networkInterfaces())
  .flatMap((addresses) => addresses ?? [])
  .filter((address) => address.family === 'IPv4' && !address.internal)
  .map((address) => address.address);
const SIGNALS = ['SIGINT', 'SIGTERM', 'SIGHUP'] as const;
const closers: (() => Promise<void>)[] = [];
let base: string;
let home: string;
let xdg: string;

/** What the caller's environment holds: the user's own server settings among them. */
function callersEnv(extra: Record<string, string | undefined> = {}) {
  return {
    PATH: process.env.PATH,
    HOME: base,
    SHEAVLY_HOME: home,
    XDG_RUNTIME_DIR: xdg,
    WORKSPACE_ROOT: base,
    SERVER_HOST: '0.0.0.0',
    SERVER_PORT: '4310',
    SERVER_TOKEN: USERS_TOKEN,
    SERVER_EXIT_WITH_PARENT: 'true',
    SERVER_DISCOVERY: 'false',
    ...extra,
  };
}

/** Starts one, remembering how to close it when the test ends. */
async function start(extra?: Record<string, string | undefined>) {
  const logs: string[] = [];
  const result = await startEmbeddedServer({
    env: callersEnv(extra),
    log: (text) => logs.push(text),
  });

  if (result.status === 'started') closers.push(result.close);

  return { result, logs };
}

async function runtimeFolder(): Promise<string> {
  return path.join(xdg, 'sheavly', await serverNameHash({ home }));
}

async function published() {
  const text = await readFile(path.join(await runtimeFolder(), 'server.json'), 'utf8');

  return discoveryFileSchema.parse(JSON.parse(text));
}

function listeners() {
  return SIGNALS.map((signal) => process.listenerCount(signal));
}

beforeEach(async () => {
  base = await mkdtemp(path.join(tmpdir(), 'embedded-server-'));
  home = path.join(base, 'home');
  xdg = path.join(base, 'xdg');
  await mkdir(xdg, { mode: 0o700 });
  await chmod(xdg, 0o700);
});

afterEach(async () => {
  for (const close of closers.splice(0)) await close();
  await rm(base, { recursive: true, force: true });
});

describe.skipIf(process.platform === 'win32')('an embedded server', () => {
  it('listens on loopback with a token of its own and a discovery file, whatever the caller’s settings say', async () => {
    const { result } = await start();
    const file = await published();
    const url = new URL(file.url);

    expect(result.status).toBe('started');
    // The caller asked for every interface, port 4310, its own token, no file and a stdin parent.
    expect(url.port).not.toBe('4310');
    expect(file.token).not.toBe(USERS_TOKEN);
    expect(file.token).toHaveLength(43);
    expect(file.pid).toBe(process.pid);
    expect((await fetch(new URL('/health', file.url))).ok).toBe(true);

    if (result.status !== 'started') throw new Error('not started');

    // The address it reports is the one it listens at.
    expect(result.url).toBe(file.url);
    expect(result.url).toBe(`http://127.0.0.1:${url.port}`);
  }, 60_000);

  // The discovery file publishes a wildcard host as 127.0.0.1, so what it says proves nothing about
  // the bind: reach the port through each address the machine has besides loopback. A machine with
  // none (a container with loopback only) skips this, rather than pass having checked nothing.
  it.skipIf(OTHER_ADDRESSES.length === 0)(
    'listens on loopback only: no other address of this machine reaches it',
    async () => {
      await start();

      const { port } = new URL((await published()).url);

      for (const address of OTHER_ADDRESSES) {
        await expect(fetch(`http://${address}:${port}/health`), address).rejects.toThrow();
      }
    },
    60_000,
  );

  it('is taken down by close: out of the file, off the port, lock released, handlers off', async () => {
    const before = listeners();
    const { result } = await start();
    const { url } = await published();

    expect(listeners()).toEqual(before.map((count) => count + 1));

    if (result.status !== 'started') throw new Error('not started');

    await result.close();
    // Once more: closing twice is the same as closing once.
    await result.close();

    expect(await readdir(await runtimeFolder())).toEqual([]);
    expect(listeners()).toEqual(before);
    await expect(fetch(new URL('/health', url))).rejects.toThrow();
  }, 60_000);

  it('is refused while another server holds the lock, changes nothing, and leaves no handler behind', async () => {
    const first = await start();
    const { token, url } = await published();
    const held = listeners();
    const second = await start();

    expect(first.result.status).toBe('started');
    expect(second.result.status).toBe('refused');

    if (second.result.status !== 'refused') throw new Error('not refused');

    expect(second.result.message).toMatch(/^Another Sheavly server is already running/);
    expect(second.result.message).toContain(`pid ${String(process.pid)}`);
    expect(second.result.message).not.toContain(token);
    // The first is still there, with the same file, and the refused start took no handler.
    expect((await published()).token).toBe(token);
    expect((await fetch(new URL('/health', url))).ok).toBe(true);
    expect(listeners()).toEqual(held);
  }, 60_000);

  // A setting fails before anything is installed or taken, so this shows the caller sees the error
  // and nothing is left; a throw after the lock was taken is held by `startServer`'s own catch.
  it('throws a setting error and leaves no handler', async () => {
    const before = listeners();

    await expect(start({ MAX_TURNS: 'not-a-number' })).rejects.toThrow();

    expect(listeners()).toEqual(before);
  }, 60_000);

  it('can be started again once it was closed, on a new port with a new token', async () => {
    const first = await start();
    const firstFile = await published();

    if (first.result.status !== 'started') throw new Error('not started');

    await first.result.close();

    const second = await start();
    const secondFile = await published();

    expect(second.result.status).toBe('started');
    expect(secondFile.token).not.toBe(firstFile.token);
    expect(secondFile.instanceId).not.toBe(firstFile.instanceId);
  }, 60_000);
});

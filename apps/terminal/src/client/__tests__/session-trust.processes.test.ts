import { mkdir, realpath } from 'node:fs/promises';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createClient } from '@sheavly/client/client/client.helper';
import { setUpTestProfile } from '@sheavly/client/testing/test-profile.fake';
import { useTempFolders } from '../../testing/temp-folders.fake.js';
import { connectBackend } from '../backend.helper.js';
import type { Backend } from '../client.types.js';
import { closeSession, openSession } from '../session.helper.js';

const folders = useTempFolders();
let backend: Backend;
let project: string;

/**
 * A backend of its own, started WITHOUT --trust, on a minimal environment (not this process's:
 * a terminal's own backend variables must not leak in) with a throwaway home and project folder,
 * and one fake model so a conversation can open. The test connects to it through BACKEND_URL.
 */
beforeEach(async () => {
  const base = await folders.make('session-trust');

  project = path.join(base, 'project');
  await mkdir(project);
  backend = await connectBackend({
    env: {
      PATH: process.env.PATH,
      HOME: base,
      SHEAVLY_HOME: path.join(base, 'home'),
      WORKSPACE_ROOT: project,
    },
    onOutput: () => undefined,
  });

  await setUpTestProfile({ backend, definition: { model: 'test' } });
}, 60_000);

afterEach(async () => {
  await backend.stop();
});

/** A terminal's session on the backend: what it printed and the workspace its run reports. */
async function runTerminal(params: { args: string[]; root?: string; workspace?: string }) {
  const written: string[] = [];
  const session = await openSession({
    env: {
      BACKEND_URL: backend.url,
      BACKEND_TOKEN: backend.token,
      WORKSPACE_ROOT: params.root ?? project,
    },
    args: params.args,
    write: (text) => written.push(text),
    ...(params.workspace && { workspace: params.workspace }),
  });
  const { workspace } = session.details;

  await closeSession(session);

  return { output: written.join(''), workspace };
}

async function terminalOn(args: string[]) {
  return (await runTerminal({ args })).output;
}

async function trustedRoots(): Promise<string[]> {
  const { workspaces } = await createClient(backend).call('queryTrustedWorkspaces', { body: {} });

  return workspaces.map(({ root }) => root);
}

describe.skipIf(process.platform === 'win32')('a backend the caller found', () => {
  it('is connected to with no BACKEND_URL, gets --trust for the folder, and keeps running after', async () => {
    const written: string[] = [];
    // No BACKEND_URL and no PATH: starting a backend instead could only fail.
    const session = await openSession({
      env: { WORKSPACE_ROOT: project },
      args: ['--trust'],
      write: (text) => written.push(text),
      server: { url: backend.url, token: backend.token },
    });

    expect(session.backend.url).toBe(backend.url);
    expect(session.details.workspace).toBe(await realpath(project));

    await closeSession(session);

    expect(await trustedRoots()).toEqual([await realpath(project)]);
    expect((await fetch(new URL('/health', backend.url))).ok).toBe(true);
    expect(written.join('')).not.toContain(backend.token);
  }, 60_000);
});

describe.skipIf(process.platform === 'win32')(
  '--trust against a backend that is already running',
  () => {
    it('trusts the terminal’s folder once, and a second front end sees it without --trust', async () => {
      expect(await trustedRoots()).toEqual([]);

      const output = await terminalOn(['--trust']);

      expect(await trustedRoots()).toEqual([await realpath(project)]);
      expect(output).not.toContain(backend.token);

      // Another front end, with no --trust: the folder is still trusted, and nothing changed.
      await terminalOn([]);
      expect(await trustedRoots()).toEqual([await realpath(project)]);
    }, 60_000);

    it('trusts nothing without --trust', async () => {
      await terminalOn([]);
      expect(await trustedRoots()).toEqual([]);
    }, 60_000);

    it('runs in the folder it trusted when the terminal’s folder differs from the backend’s own', async () => {
      const other = path.join(path.dirname(project), 'other');

      await mkdir(other);

      const { workspace } = await runTerminal({ args: ['--trust'], root: other });

      expect(await trustedRoots()).toEqual([await realpath(other)]);
      expect(workspace).toBe(await realpath(other));
      expect(workspace).not.toBe(await realpath(project));
    }, 60_000);

    it('trusts the workspace it was given and runs in it', async () => {
      const given = path.join(path.dirname(project), 'given');

      await mkdir(given);

      const { workspace } = await runTerminal({ args: ['--trust'], workspace: given });

      expect(await trustedRoots()).toEqual([await realpath(given)]);
      expect(workspace).toBe(await realpath(given));
    }, 60_000);

    it('without --trust runs in the backend’s own folder and trusts nothing', async () => {
      const other = path.join(path.dirname(project), 'other');

      await mkdir(other);

      const { workspace } = await runTerminal({ args: [], root: other });

      expect(workspace).toBe(await realpath(project));
      expect(await trustedRoots()).toEqual([]);
    }, 60_000);

    it('goes on in the backend’s own folder, untrusted, when the terminal’s folder is refused as a workspace', async () => {
      // The backend's home folder is `base`, which no workspace may be.
      const refused = path.dirname(project);
      const { output, workspace } = await runTerminal({ args: ['--trust'], root: refused });

      expect(workspace).toBe(await realpath(project));
      expect(output).toContain('not trusted');
      expect(await trustedRoots()).toEqual([]);
    }, 60_000);

    it('reports a failing trust call, names the folder and never prints the token', async () => {
      const failure = await runTerminal({
        args: ['--trust'],
        // A folder that does not exist cannot be trusted.
        workspace: path.join(project, 'missing'),
      }).catch((caughtError: unknown) => caughtError);

      expect(failure).toBeInstanceOf(Error);
      expect((failure as Error).message).toContain(path.join(project, 'missing'));
      expect(`${String(failure)}${String((failure as Error).stack)}`).not.toContain(backend.token);
      expect(await trustedRoots()).toEqual([]);
    }, 60_000);
  },
);

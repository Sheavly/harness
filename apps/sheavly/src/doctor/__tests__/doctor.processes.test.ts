import { existsSync } from 'node:fs';
import { readdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { treeSnapshot } from '@sheavly/backend/testing/held-server.fake';
import { setUpTestProfile } from '@sheavly/client/testing/test-profile.fake';
import { DISCOVERY_FILE_NAME } from '@sheavly/protocol/discovery/discovery.constants';
import { PROTOCOL_VERSION } from '@sheavly/protocol/version/protocol-version.constants';
import { PROTOCOL_MISMATCH_MESSAGES } from '@sheavly/protocol/version/version.constants';
import { useFinderScenarios } from '../../testing/finder-scenarios.fake.js';

const scenarios = useFinderScenarios();
const { cli } = scenarios;

/** What `sheavly doctor` ended with: its exit, and what it printed on each stream. */
async function doctor() {
  const made = await cli.startAndWaitForExit({}, ['doctor']);
  const exit = await made.exited;

  return { code: exit.code, out: made.stdout(), err: made.stderr() };
}

/** The report's line for one check: the line that starts with its status and label. */
function lineOf(report: string, label: string): string {
  return (
    report.split('\n').find((line) => new RegExp(`^(ok|FAIL)\\s+${label}\\s`).test(line)) ?? ''
  );
}

/** What a read must not change: every file under the home and the runtime folder, with its mtime. */
async function everything(): Promise<string[]> {
  const { home, xdg } = cli.folders();
  const homeTree = existsSync(home) ? await treeSnapshot(home) : [];

  return [...homeTree, ...(await treeSnapshot(xdg))];
}

function expectNoToken(result: { out: string; err: string }) {
  expect(`${result.out}${result.err}`).not.toContain(cli.folders().token);
}

describe.skipIf(process.platform === 'win32')(
  'sheavly doctor, on real servers and planted files',
  () => {
    it('reports a running, verified server and a profile, exits 0, and changes nothing', async () => {
      const server = await cli.start({}, ['serve']);

      await setUpTestProfile({
        backend: { url: server.url, token: cli.folders().token },
        definition: { model: 'fake', baseUrl: 'http://127.0.0.1:9/v1' },
      });

      const before = await everything();
      const result = await doctor();

      expect(result.code).toBe(0);
      expect(lineOf(result.out, 'Node')).toMatch(/^ok\s/);
      expect(lineOf(result.out, 'Home')).toContain('private, writable');
      expect(lineOf(result.out, 'Server')).toContain(
        `running and verified (protocol ${PROTOCOL_VERSION})`,
      );
      expect(lineOf(result.out, 'Profile')).toContain('default profile');
      expect(result.out).toContain('Everything checks out.');
      expect(result.err).toBe('');
      expectNoToken(result);
      expect(result.out).not.toContain(server.url);
      expect(await everything()).toEqual(before);
      // It only looked: the server it found is still running.
      expect((await fetch(new URL('/health', server.url))).ok).toBe(true);
    }, 120_000);

    it('with no server and no home exits 1, names each failing check, and creates nothing', async () => {
      const result = await doctor();

      expect(result.code).toBe(1);
      expect(lineOf(result.out, 'Node')).toMatch(/^ok\s/);
      expect(lineOf(result.out, 'Home')).toMatch(/^ok\s.*does not exist yet/);
      expect(lineOf(result.out, 'Server')).toMatch(/^FAIL\s.*none running/);
      expect(result.out).toContain('No discovery file in');
      expect(result.out).toContain('sheavly serve');
      expect(lineOf(result.out, 'Profile')).toMatch(/^FAIL\s.*no profile is set up/);
      expect(result.err).toMatch(/^sheavly: \d+ check\(s\) failed\n$/);
      expect(await readdir(cli.folders().xdg)).toEqual([]);
      expect(existsSync(cli.folders().home)).toBe(false);
    }, 60_000);

    it('says the file a killed server left is left over, contacts nothing, and changes nothing', async () => {
      const server = await cli.start({}, ['serve']);

      await server.stop('SIGKILL');

      const before = await everything();
      const result = await doctor();

      expect(result.code).toBe(1);
      expect(lineOf(result.out, 'Server')).toContain('none running');
      expect(result.out).toContain('left over');
      expectNoToken(result);
      expect(await everything()).toEqual(before);
    }, 60_000);

    it('never contacts the address in a file whose lock is free', async () => {
      const listener = await scenarios.plantLeftOver();
      const result = await doctor();

      expect(result.code).toBe(1);
      expect(result.out).toContain('left over');
      expect(listener.requests()).toEqual([]);
      expectNoToken(result);
    }, 60_000);

    it('reports a file others can open as refused, without reading it', async () => {
      const directory = await scenarios.runtimeFolder();

      await writeFile(path.join(directory, DISCOVERY_FILE_NAME), cli.folders().token, {
        mode: 0o644,
      });

      const result = await doctor();

      expect(result.code).toBe(1);
      expect(result.out).toContain('was refused (too-open)');
      expectNoToken(result);
    }, 60_000);

    it('reports a file that is not a discovery file as invalid', async () => {
      const directory = await scenarios.runtimeFolder();
      const notOurs = `{"token":"${cli.folders().token}"}`;

      await writeFile(path.join(directory, DISCOVERY_FILE_NAME), notOurs, { mode: 0o600 });

      const result = await doctor();

      expect(result.code).toBe(1);
      expect(result.out).toContain('is not one of this format');
      expectNoToken(result);
    }, 60_000);

    it('stops before the token is sent when an impostor answers on the recorded address', async () => {
      const impostor = await scenarios.plantImpostor();
      const result = await doctor();

      expect(result.code).toBe(1);
      expect(lineOf(result.out, 'Server')).toContain('none running');
      expect(result.out).toContain('nothing secret was sent');
      expectNoToken(result);
      scenarios.expectNothingSecretSent(impostor);
    }, 60_000);

    it('says which side is older for a server of another protocol, and sends it no token', async () => {
      const other = '5.0.0';
      const server = await scenarios.plantOtherProtocol(other);
      const result = await doctor();

      expect(result.code).toBe(1);
      expect(lineOf(result.out, 'Server')).toMatch(/^FAIL\s/);
      expect(result.out).toContain(
        PROTOCOL_MISMATCH_MESSAGES.clientOlder
          .replaceAll('{client}', PROTOCOL_VERSION)
          .replaceAll('{server}', other),
      );
      expectNoToken(result);
      scenarios.expectNothingSecretSent(server);
    }, 60_000);

    it('exits 1 for a running server with no profile, naming the one problem', async () => {
      await cli.start({}, ['serve']);

      const result = await doctor();

      expect(result.code).toBe(1);
      expect(lineOf(result.out, 'Server')).toMatch(/^ok\s/);
      expect(lineOf(result.out, 'Profile')).toMatch(/^FAIL\s.*no profile is set up/);
      expect(result.out).toContain('1 problem(s) found.');
      expectNoToken(result);
    }, 90_000);
  },
);

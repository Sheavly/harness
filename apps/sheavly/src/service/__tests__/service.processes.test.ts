import { existsSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { useFinderScenarios } from '../../testing/finder-scenarios.fake.js';

// Only what is refused before systemd is asked: a test must never install a service on the
// machine it runs on. The commands that do talk to systemd are tested with a fake in
// `service.helper.test.ts`.
const scenarios = useFinderScenarios();
const { cli } = scenarios;
const STACK = /\n\s+at /;

/** `sheavly service …`, run for real from the checkout. */
async function service(args: readonly string[]) {
  const made = await cli.startAndWaitForExit({}, ['service', ...args]);

  return { exit: await made.exited, out: made.stdout(), err: made.stderr() };
}

describe.skipIf(process.platform === 'win32')('sheavly service, from the checkout', () => {
  it('lists its actions with --help and starts nothing', async () => {
    const { exit, out } = await service(['--help']);

    expect(exit.code).toBe(0);
    expect(out).toContain('Usage: sheavly service <action>');

    for (const action of ['install', 'uninstall', 'start', 'stop', 'restart', 'status', 'logs']) {
      expect(out).toContain(`  ${action} `);
    }

    expect(out).toContain('never written into the unit');
    expect(existsSync(cli.folders().home)).toBe(false);
  }, 60_000);

  it('exits 2 with one line and no stack for no action or an unknown one', async () => {
    const none = await service([]);
    const unknown = await service(['reinstall']);

    expect([none.exit.code, unknown.exit.code]).toEqual([2, 2]);
    expect(none.err).toContain(
      'takes one of install, uninstall, start, stop, restart, status, logs',
    );
    expect(unknown.err).toContain('got "reinstall"');
    expect(`${none.err}${unknown.err}`).not.toMatch(STACK);
  }, 90_000);

  it('refuses install from source with exit 1, saying to build, and writes nothing', async () => {
    const result = await service(['install', '--yes']);

    expect(result.exit.code).toBe(1);
    expect(result.err).toContain('runs the built command');
    expect(result.err).toContain('build first');
    expect(result.err).not.toMatch(STACK);
    expect(result.out).toBe('');
    expect(existsSync(cli.folders().home)).toBe(false);
  }, 60_000);

  it('refuses --trust on install with exit 1, whatever else is asked', async () => {
    const result = await service(['install', '--yes', '--trust']);

    expect(result.exit.code).toBe(1);
    expect(result.err).toContain('does not take --trust');
    expect(result.out).toBe('');
  }, 60_000);
});

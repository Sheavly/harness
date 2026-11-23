import { chmod, mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ServiceError, UsageError } from '../../errors/cli.errors.js';
import { fakeSystemTools } from '../../testing/system-tools.fake.js';
import { createServiceCommand } from '../service.helper.js';
import type { ServiceDeps, SystemCall } from '../service.types.js';

let root: string;

beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), 'service-'));
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

/** The command on a temp home, with `answer` playing systemd, and everything it printed. */
function setUp(
  params: {
    answer?: (call: SystemCall) => Partial<{ status: 'ok' | 'failed' | 'missing'; stdout: string }>;
    deps?: Partial<ServiceDeps>;
    env?: NodeJS.ProcessEnv;
    follow?: number | 'missing';
  } = {},
) {
  // A stopped or absent unit says `inactive`, as systemd does, unless a test plays another state.
  const fake = fakeSystemTools(
    (call) => ({
      ...(call.args.includes('is-active') ? { stdout: 'inactive\n' } : {}),
      ...params.answer?.(call),
    }),
    { ...(params.follow !== undefined && { follow: params.follow }) },
  );
  const out: string[] = [];
  const confirm = vi.fn(() => Promise.resolve(true));
  const deps: ServiceDeps = {
    platform: 'linux',
    nodePath: '/usr/bin/node',
    cliPath: '/opt/sheavly/dist/cli.js',
    homeDir: path.join(root, 'user'),
    uid: 1000,
    system: fake.system,
    interactive: true,
    confirm,
    streams: { out: (text) => out.push(text), err: (text) => out.push(text) },
    ...params.deps,
  };
  const env = {
    SHEAVLY_HOME: path.join(root, 'home'),
    XDG_CONFIG_HOME: path.join(root, 'config'),
    PATH: '/usr/bin:/home/me/.nvm/bin',
    ...params.env,
  };

  return {
    ...fake,
    confirm,
    env,
    printed: () => out.join(''),
    run: (...args: string[]) => createServiceCommand(deps).run({ args, env }),
    /** `run` with `extra` added to the environment, as from another shell. */
    runWith: (extra: NodeJS.ProcessEnv, ...args: string[]) =>
      createServiceCommand(deps).run({ args, env: { ...env, ...extra } }),
    unit: path.join(root, 'config', 'systemd', 'user', 'sheavly.service'),
    tokenFile: path.join(root, 'home', 'service.env'),
  };
}

/** The token a token file holds. */
async function tokenIn(file: string): Promise<string> {
  const text = await readFile(file, 'utf8');

  return text.replace('SERVER_TOKEN=', '').trim();
}

/** Everything a run of the command could have shown or passed on: its output and every argument. */
function everything(setup: ReturnType<typeof setUp>): string {
  return [setup.printed(), ...setup.calls.map((call) => call.args.join(' '))].join('\n');
}

describe('service install', () => {
  it('says what it will do first, then writes the token file and the unit, turns on linger, enables and starts', async () => {
    const setup = setUp();

    await setup.run('install', '--yes');

    expect(setup.printed()).toMatch(/This will:[\s\S]*linger[\s\S]*Installed and enabled/);
    expect(setup.printed()).toContain('PATH=/usr/bin:/home/me/.nvm/bin');
    expect(setup.printed()).toContain('systemd was asked to start it');
    expect(await readFile(setup.unit, 'utf8')).toContain(
      `ExecStart="/usr/bin/node" "/opt/sheavly/dist/cli.js" serve`,
    );
    expect(await readFile(setup.unit, 'utf8')).toContain(`EnvironmentFile=${setup.tokenFile}`);
    expect(setup.commands('systemctl')).toEqual([
      '--user show-environment',
      '--user daemon-reload',
      `--user enable sheavly.service`,
      `--user start sheavly.service`,
    ]);
    expect(setup.commands('loginctl')).toEqual(['enable-linger']);
  });

  it('keeps the token in a file only the user can read and never in the unit, the output or an argument', async () => {
    const setup = setUp();

    await setup.run('install', '--yes');

    const token = await tokenIn(setup.tokenFile);

    expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect((await stat(setup.tokenFile)).mode & 0o777).toBe(0o600);
    expect(await readFile(setup.unit, 'utf8')).not.toContain(token);
    expect(everything(setup)).not.toContain(token);
  });

  it('puts the installing shell’s PATH and SHEAVLY_HOME in the unit', async () => {
    const setup = setUp();

    await setup.run('install', '--yes');

    const unit = await readFile(setup.unit, 'utf8');

    expect(unit).toContain('Environment="PATH=/usr/bin:/home/me/.nvm/bin"');
    expect(unit).toContain(`Environment="SHEAVLY_HOME=${path.join(root, 'home')}"`);
  });

  it('installed twice is harmless: it keeps the token, leaves one unit, and restarts nothing', async () => {
    const setup = setUp();

    await setup.run('install', '--yes');

    const token = await tokenIn(setup.tokenFile);
    const unit = await readFile(setup.unit, 'utf8');

    await setup.run('install', '--yes');

    expect(await tokenIn(setup.tokenFile)).toBe(token);
    expect(await readFile(setup.unit, 'utf8')).toBe(unit);
    expect(setup.commands('systemctl').filter((line) => line.includes('restart'))).toEqual([]);
    expect(setup.printed()).not.toContain('The unit changed');
    expect(await readdir(path.dirname(setup.unit))).toEqual(['sheavly.service']);
  });

  it('refreshes the unit with the new PATH when installed again, and says restart applies it', async () => {
    const setup = setUp();

    await setup.run('install', '--yes');
    expect(setup.printed()).not.toContain('The unit changed');

    await setup.runWith({ PATH: '/usr/bin:/new/bin' }, 'install', '--yes');

    expect(await readFile(setup.unit, 'utf8')).toContain('PATH=/usr/bin:/new/bin');
    expect(setup.printed()).toContain('The unit changed: `sheavly service restart` applies it');
    expect(setup.commands('systemctl').filter((line) => line.includes('restart'))).toEqual([]);
  });

  it('asks first, and changes nothing when the answer is no', async () => {
    const setup = setUp();

    setup.confirm.mockResolvedValueOnce(false);
    await setup.run('install');

    expect(setup.confirm).toHaveBeenCalledOnce();
    expect(setup.printed()).toContain('Nothing was changed.');
    expect(setup.commands('loginctl')).toEqual([]);
    await expect(stat(setup.unit)).rejects.toThrow();
    await expect(stat(setup.tokenFile)).rejects.toThrow();
  });

  it('with no terminal and no --yes refuses to guess, and changes nothing', async () => {
    const setup = setUp({ deps: { interactive: false } });

    await expect(setup.run('install')).rejects.toThrow('pass --yes');
    expect(setup.confirm).not.toHaveBeenCalled();
    await expect(stat(setup.unit)).rejects.toThrow();
  });

  it('refuses --trust, before it asks or writes anything', async () => {
    const setup = setUp();

    await expect(setup.run('install', '--trust')).rejects.toThrow('does not take --trust');
    await expect(setup.run('install', '--yes', '--trust')).rejects.toThrow(ServiceError);
    expect(setup.calls).toEqual([]);
    expect(setup.confirm).not.toHaveBeenCalled();
    await expect(stat(setup.tokenFile)).rejects.toThrow();
  });

  it('refuses another argument as a usage error', async () => {
    await expect(setUp().run('install', '--now')).rejects.toThrow(UsageError);
  });

  it('refuses to run from source, and says to build', async () => {
    const setup = setUp({ deps: { cliPath: '/repo/apps/sheavly/src/cli.ts' } });

    await expect(setup.run('install', '--yes')).rejects.toThrow('build first');
    expect(setup.calls).toEqual([]);
    await expect(stat(setup.unit)).rejects.toThrow();
  });

  it('refuses a file that is not cli.js, since only the built command is run', async () => {
    const setup = setUp({ deps: { cliPath: '/opt/other/wrapper.js' } });

    await expect(setup.run('install', '--yes')).rejects.toThrow('build first');
    expect(setup.calls).toEqual([]);
  });

  it.each([
    ['', 'PATH is empty'],
    ['/usr/bin::/bin', 'an empty entry'],
    ['/usr/bin:.', 'relative entry "."'],
  ])(
    'refuses PATH %j, which would go into an always-on server, before it asks',
    async (value, why) => {
      const setup = setUp({ env: { PATH: value } });

      await expect(setup.run('install', '--yes')).rejects.toThrow(why);
      expect(setup.calls).toEqual([]);
      expect(setup.confirm).not.toHaveBeenCalled();
      await expect(stat(setup.tokenFile)).rejects.toThrow();
    },
  );

  it('refuses on another system, and says to run sheavly serve', async () => {
    const setup = setUp({ deps: { platform: 'darwin' } });

    await expect(setup.run('install', '--yes')).rejects.toThrow('needs Linux with systemd');
    expect(setup.calls).toEqual([]);
  });

  it('refuses where systemctl is not installed', async () => {
    const setup = setUp({ answer: () => ({ status: 'missing' }) });

    await expect(setup.run('install', '--yes')).rejects.toThrow('systemctl is not installed');
    await expect(stat(setup.unit)).rejects.toThrow();
  });

  it('refuses where there is no user manager, and says why', async () => {
    const setup = setUp({ answer: () => ({ status: 'failed' }) });

    await expect(setup.run('install', '--yes')).rejects.toThrow('no user manager is running');
    await expect(stat(setup.tokenFile)).rejects.toThrow();
  });

  it('refuses a token file that others can read, and does not replace it', async () => {
    const setup = setUp();

    await mkdir(path.dirname(setup.tokenFile), { recursive: true });
    await writeFile(setup.tokenFile, `SERVER_TOKEN=${'A'.repeat(43)}\n`);
    await chmod(setup.tokenFile, 0o644);

    await expect(setup.run('install', '--yes')).rejects.toThrow('can be read by other users');
    expect(await readFile(setup.tokenFile, 'utf8')).toBe(`SERVER_TOKEN=${'A'.repeat(43)}\n`);
    await expect(stat(setup.unit)).rejects.toThrow();
  });

  it('refuses a token file it did not write, and does not replace it', async () => {
    const setup = setUp();

    await mkdir(path.dirname(setup.tokenFile), { recursive: true });
    await writeFile(setup.tokenFile, 'something else', { mode: 0o600 });

    await expect(setup.run('install', '--yes')).rejects.toThrow('not a token file');
    expect(await readFile(setup.tokenFile, 'utf8')).toBe('something else');
  });

  it('refuses a home whose path a unit cannot take safely', async () => {
    const setup = setUp({ env: { SHEAVLY_HOME: path.join(root, 'a b') } });

    await expect(setup.run('install', '--yes')).rejects.toThrow('characters a unit file cannot');
  });

  it('reports the first line of a failing systemd command, without the rest', async () => {
    const setup = setUp({
      answer: ({ args }) =>
        args.includes('enable') ? { status: 'failed', stdout: '', stderr: 'no\nsecond line' } : {},
    });

    await expect(setup.run('install', '--yes')).rejects.toThrow(
      /enable sheavly.service failed: no$/,
    );
  });
});

describe('service uninstall', () => {
  it('stops and removes the unit and the token file, leaves the data and linger alone, and says how to turn linger off', async () => {
    const setup = setUp();

    await setup.run('install', '--yes');
    await mkdir(path.join(root, 'home', 'profiles'), { recursive: true });
    await writeFile(path.join(root, 'home', 'profiles', 'keep.json'), '{}');
    await setup.run('uninstall');

    await expect(stat(setup.unit)).rejects.toThrow();
    await expect(stat(setup.tokenFile)).rejects.toThrow();
    expect(await readdir(path.join(root, 'home', 'profiles'))).toEqual(['keep.json']);
    expect(setup.commands('systemctl')).toContain('--user disable --now sheavly.service');
    expect(setup.commands('loginctl')).toEqual(['enable-linger']);
    expect(setup.printed()).toContain('loginctl disable-linger');
  });

  it.each([
    ['active', 'active\n'],
    ['deactivating, a stop that outlasts the time limit', 'deactivating\n'],
    ['activating', 'activating\n'],
    ['no answer at all (a timeout)', ''],
  ])('removes nothing when it cannot tell the service stopped: %s', async (_name, stdout) => {
    const setup = setUp({
      answer: ({ args }) => (args.includes('is-active') ? { stdout } : {}),
    });

    await setup.run('install', '--yes');
    await expect(setup.run('uninstall')).rejects.toThrow('may still be running');
    expect((await stat(setup.unit)).isFile()).toBe(true);
    expect((await stat(setup.tokenFile)).isFile()).toBe(true);
  });

  it.each(['inactive\n', 'failed\n'])('removes the files once it says %j', async (stdout) => {
    const setup = setUp({
      answer: ({ args }) => (args.includes('is-active') ? { stdout } : {}),
    });

    await setup.run('install', '--yes');
    await setup.run('uninstall');

    await expect(stat(setup.unit)).rejects.toThrow();
    await expect(stat(setup.tokenFile)).rejects.toThrow();
  });

  it('leaves a service.env it did not write, and says so', async () => {
    const setup = setUp();

    await mkdir(path.dirname(setup.tokenFile), { recursive: true });
    await writeFile(setup.tokenFile, 'not a token file', { mode: 0o600 });
    await setup.run('uninstall');

    expect(await readFile(setup.tokenFile, 'utf8')).toBe('not a token file');
    expect(setup.printed()).toContain('is not a token file this command wrote, so it was left');
    expect(setup.printed()).not.toContain('Nothing was installed.');
  });

  it('uninstalled twice is harmless and says nothing was installed', async () => {
    const setup = setUp();

    await setup.run('uninstall');

    expect(setup.printed()).toContain('Nothing was installed.');
  });
});

describe('service start, stop and restart', () => {
  it('refuses when it is not installed', async () => {
    await expect(setUp().run('start')).rejects.toThrow('not installed');
  });

  it('runs the systemd command, and says stopping and restarting end running conversations', async () => {
    const setup = setUp();

    await setup.run('install', '--yes');
    await setup.run('start');
    await setup.run('stop');
    await setup.run('restart');

    const controls = setup
      .commands('systemctl')
      .filter((line) => !line.includes('show-environment'));

    // A start or restart first clears a start limit a failing server tripped; a stop does not.
    expect(controls.slice(-5)).toEqual([
      '--user reset-failed sheavly.service',
      '--user start sheavly.service',
      '--user stop sheavly.service',
      '--user reset-failed sheavly.service',
      '--user restart sheavly.service',
    ]);
    expect(setup.printed().match(/Conversations that were running stopped/g)).toHaveLength(2);
  });
});

describe('service status', () => {
  const RUNNING = ({ tool, args }: SystemCall) => {
    if (tool === 'loginctl' && args.includes('show-user')) return { stdout: 'Linger=yes\n' };

    if (args.includes('show')) {
      return { stdout: 'ActiveState=active\nSubState=running\nActiveEnterTimestamp=Mon 10:00\n' };
    }

    return args.includes('is-enabled') ? { stdout: 'enabled\n' } : {};
  };

  it('says installed, enabled, running and linger, one line each', async () => {
    const setup = setUp({ answer: RUNNING });

    await setup.run('install', '--yes');
    await setup.run('status');

    expect(setup.printed()).toContain('installed: yes');
    expect(setup.printed()).toContain('enabled: yes');
    expect(setup.printed()).toContain('running: yes (running since Mon 10:00)');
    expect(setup.printed()).toContain('linger: yes');
  });

  it('exits non-zero when it is installed but not running, after saying so', async () => {
    const setup = setUp({
      answer: ({ args }) => (args.includes('show') ? { stdout: 'ActiveState=inactive\n' } : {}),
    });

    await setup.run('install', '--yes');
    await expect(setup.run('status')).rejects.toThrow('not running');
    expect(setup.printed()).toContain('running: no');
  });

  it('says it is not installed when it is not', async () => {
    const setup = setUp();

    await expect(setup.run('status')).rejects.toThrow('not installed');
    expect(setup.printed()).toContain('installed: no');
  });
});

describe('service logs', () => {
  it('shows the last lines of the unit’s journal, and follows with --follow', async () => {
    const setup = setUp();

    await setup.run('logs');
    await setup.run('logs', '--follow');

    expect(setup.commands('journalctl')).toEqual([
      '--user -u sheavly.service -n 100 --no-pager',
      '--user -u sheavly.service -n 100 --follow',
    ]);
  });

  it('refuses another argument', async () => {
    await expect(setUp().run('logs', '--all')).rejects.toThrow(ServiceError);
  });

  it('says journalctl is not installed, not just that it ended', async () => {
    await expect(setUp({ follow: 'missing' }).run('logs')).rejects.toThrow(
      'journalctl is not installed',
    );
  });

  it('reports the exit code of a journalctl that failed', async () => {
    await expect(setUp({ follow: 3 }).run('logs')).rejects.toThrow('journalctl ended with exit 3');
  });
});

describe('service', () => {
  it('takes one of its actions, and says which when given none or another', async () => {
    const setup = setUp();

    await expect(setup.run()).rejects.toThrow(UsageError);
    await expect(setup.run('restart-all')).rejects.toThrow('got "restart-all"');
    expect(setup.calls).toEqual([]);
  });

  it.each(['uninstall', 'start', 'stop', 'restart', 'status'])(
    'refuses an argument to %s, as a usage error, before it asks systemd anything',
    async (action) => {
      const setup = setUp();

      await expect(setup.run(action, '--now')).rejects.toThrow(UsageError);
      await expect(setup.run(action, '--now')).rejects.toThrow('takes no argument, got "--now"');
      expect(setup.calls).toEqual([]);
    },
  );
});

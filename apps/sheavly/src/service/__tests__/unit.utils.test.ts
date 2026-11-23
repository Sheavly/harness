import { describe, expect, it } from 'vitest';
import { ServiceError } from '../../errors/cli.errors.js';
import {
  parseTokenFile,
  pathProblem,
  renderTokenFile,
  serviceFiles,
} from '../service-files.utils.js';
import { quoteForExec, quoteForUnit, renderUnit } from '../unit.utils.js';

const PARAMS = {
  nodePath: '/usr/bin/node',
  cliPath: '/opt/sheavly/dist/cli.js',
  home: '/home/me/.sheavly',
  path: '/usr/bin:/home/me/.nvm/bin',
  envFile: '/home/me/.sheavly/service.env',
};

describe('renderUnit', () => {
  it('writes the whole unit as text: the built command, the token file, restart on failure', () => {
    expect(renderUnit(PARAMS)).toBe(
      [
        '[Unit]',
        'Description=Sheavly server',
        'StartLimitIntervalSec=300',
        'StartLimitBurst=5',
        '',
        '[Service]',
        'Type=simple',
        'ExecStart="/usr/bin/node" "/opt/sheavly/dist/cli.js" serve',
        'WorkingDirectory=%h',
        'EnvironmentFile=/home/me/.sheavly/service.env',
        'Environment="SHEAVLY_HOME=/home/me/.sheavly"',
        'Environment="PATH=/usr/bin:/home/me/.nvm/bin"',
        'Restart=on-failure',
        'RestartSec=5',
        '',
        '[Install]',
        'WantedBy=default.target',
        '',
      ].join('\n'),
    );
  });

  it('has no token line and never passes --trust: the token reaches the server by the file only', () => {
    const unit = renderUnit(PARAMS);

    // `renderUnit` takes no token, so no unit it makes can hold one; this pins the shape of what
    // the server is given instead (the file named by `EnvironmentFile=`, and nothing set inline).
    expect(unit).not.toMatch(/SERVER_TOKEN/);
    expect(unit).not.toContain('--trust');
    expect(unit).toContain(`EnvironmentFile=${PARAMS.envFile}`);
  });

  it('keeps a $ in PATH as it is, since Environment= does not expand it, and doubles it in ExecStart', () => {
    const unit = renderUnit({ ...PARAMS, path: '/usr/bin:/odd$dir', cliPath: '/opt/a$b/cli.js' });

    expect(unit).toContain('Environment="PATH=/usr/bin:/odd$dir"');
    expect(unit).toContain('ExecStart="/usr/bin/node" "/opt/a$$b/cli.js" serve');
  });

  it('writes the log to the journal, which is a unit’s default, and sets no StandardOutput', () => {
    expect(renderUnit(PARAMS)).not.toMatch(/Standard(Output|Error)/);
  });
});

describe('quoteForUnit', () => {
  it('quotes a value as one word', () => {
    expect(quoteForUnit('/a b/c')).toBe('"/a b/c"');
  });

  it('escapes what a unit would expand or end a word with, and leaves a $ alone', () => {
    expect(quoteForUnit('a"b\\c')).toBe(String.raw`"a\"b\\c"`);
    expect(quoteForUnit('%h/$HOME')).toBe('"%%h/$HOME"');
  });

  it('doubles a $ for ExecStart, which expands variables', () => {
    expect(quoteForExec('%h/$HOME')).toBe('"%%h/$$HOME"');
    expect(quoteForExec('a"b')).toBe(String.raw`"a\"b"`);
  });

  it('refuses a line break and a NUL, which no quoting makes safe', () => {
    expect(() => quoteForUnit('a\nExecStart=/bin/evil')).toThrow(ServiceError);
    expect(() => quoteForUnit('a\r')).toThrow(ServiceError);
    expect(() => quoteForUnit('a\0b')).toThrow(ServiceError);
  });

  it('keeps a path with a line break out of the unit', () => {
    expect(() => renderUnit({ ...PARAMS, path: '/bin\nExecStartPre=/bin/evil' })).toThrow(
      ServiceError,
    );
  });
});

describe('serviceFiles', () => {
  it('puts the unit in the XDG config folder when set, else ~/.config, and the token beside the data', () => {
    expect(
      serviceFiles({ env: { XDG_CONFIG_HOME: '/cfg' }, homeDir: '/home/me', sheavlyHome: '/s' }),
    ).toEqual({
      home: '/s',
      unit: '/cfg/systemd/user/sheavly.service',
      tokenFile: '/s/service.env',
    });
    expect(serviceFiles({ env: {}, homeDir: '/home/me', sheavlyHome: '/s' }).unit).toBe(
      '/home/me/.config/systemd/user/sheavly.service',
    );
  });

  it('makes a relative home absolute, since systemd reads the unit from another folder', () => {
    const files = serviceFiles({ env: {}, homeDir: '/home/me', sheavlyHome: 'data/home' });

    expect(files.home).toBe(`${process.cwd()}/data/home`);
    expect(files.tokenFile).toBe(`${process.cwd()}/data/home/service.env`);
  });

  it('treats an empty XDG_CONFIG_HOME as not set', () => {
    expect(
      serviceFiles({ env: { XDG_CONFIG_HOME: '' }, homeDir: '/home/me', sheavlyHome: '/s' }).unit,
    ).toBe('/home/me/.config/systemd/user/sheavly.service');
  });
});

describe('pathProblem', () => {
  it('accepts a PATH of absolute entries', () => {
    expect(pathProblem('/usr/bin:/home/me/.nvm/bin')).toBeUndefined();
  });

  it.each([
    ['', 'PATH is empty'],
    ['/usr/bin::/bin', 'an empty entry'],
    [':/usr/bin', 'an empty entry'],
    ['/usr/bin:', 'an empty entry'],
    ['/usr/bin:.', 'relative entry "."'],
    ['bin:/usr/bin', 'relative entry "bin"'],
    ['/usr/bin:../x', 'relative entry "../x"'],
  ])('says what is wrong with %j', (value, problem) => {
    expect(pathProblem(value)).toContain(problem);
  });
});

describe('the token file', () => {
  const TOKEN = 'A'.repeat(43);

  it('is one line the server reads, and reads back what it wrote', () => {
    expect(renderTokenFile(TOKEN)).toBe(`SERVER_TOKEN=${TOKEN}\n`);
    expect(parseTokenFile(renderTokenFile(TOKEN))).toBe(TOKEN);
  });

  it('is not taken for a token file when it holds anything else', () => {
    expect(parseTokenFile('')).toBeUndefined();
    expect(parseTokenFile('SERVER_TOKEN=short')).toBeUndefined();
    expect(parseTokenFile(`SERVER_TOKEN=${TOKEN}\nOTHER=1`)).toBeUndefined();
    expect(parseTokenFile(`# note\nSERVER_TOKEN=${TOKEN}`)).toBeUndefined();
  });
});

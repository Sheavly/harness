import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { dispatch } from '../../dispatch/dispatch.helper.js';
import { createDoctorCommand } from '../doctor.helper.js';

let home: string;

beforeEach(async () => {
  home = await mkdtemp(path.join(tmpdir(), 'doctor-command-'));
});

afterEach(async () => {
  await rm(home, { recursive: true, force: true });
});

/** Runs `sheavly doctor <args>` through the dispatcher, as the process does, with collectors. */
async function doctor(params: {
  args?: string[];
  nodeVersion: string;
  env?: Record<string, string>;
}) {
  const out: string[] = [];
  const err: string[] = [];
  const streams = { out: (text: string) => out.push(text), err: (text: string) => err.push(text) };
  const code = await dispatch({
    argv: ['doctor', ...(params.args ?? [])],
    env: {
      SHEAVLY_HOME: home,
      XDG_RUNTIME_DIR: path.join(home, 'no-runtime'),
      ...params.env,
    },
    commands: [
      createDoctorCommand({
        nodeVersion: params.nodeVersion,
        uid: process.getuid?.() ?? 0,
        platform: process.platform,
        streams,
      }),
    ],
    streams,
    readVersion: () => Promise.resolve('0.0.0'),
  });

  return { code, out: out.join(''), err: err.join('') };
}

describe('sheavly doctor', () => {
  it('exits 1 and prints the report when a check fails', async () => {
    const old = await doctor({ nodeVersion: '22.1.0' });

    expect(old.code).toBe(1);
    expect(old.out).toContain('FAIL  Node');
    expect(old.out).toContain('22.1.0 is too old');
    expect(old.err).toMatch(/^sheavly: \d+ check\(s\) failed\n$/);
  });

  it('reports every check, each with its own line, even when the first fails', async () => {
    const { out } = await doctor({ nodeVersion: '22.1.0' });

    expect(out.split('\n').filter((line) => /^(ok|FAIL)\s/.test(line))).toHaveLength(4);
    expect(out).toMatch(/Home\s/);
    expect(out).toMatch(/Server\s/);
    expect(out).toMatch(/Profile\s/);
  });

  it('reports every check as a finding even when each of them throws, naming no path', async () => {
    // A NUL byte in the home makes every path call throw: no check can run.
    const result = await doctor({ nodeVersion: '24.0.0', env: { SHEAVLY_HOME: 'bad\u0000home' } });

    expect(result.code).toBe(1);
    expect(result.out).toMatch(/^ok\s+Node\s/m);
    expect(result.out).toMatch(/^FAIL\s+Home\s+could not be checked \(\w+\)$/m);
    expect(result.out).toMatch(/^FAIL\s+Server\s+could not be checked \(\w+\)$/m);
    expect(result.out).toMatch(/^FAIL\s+Profile\s/m);
    expect(result.out).not.toContain('bad');
  });

  it('says when BACKEND_URL makes chat skip the file doctor looks at, without printing it', async () => {
    const result = await doctor({
      nodeVersion: '24.0.0',
      env: { BACKEND_URL: 'http://127.0.0.1:9/secret-path' },
    });

    expect(result.out).toContain('BACKEND_URL is set');
    expect(result.out).not.toContain('secret-path');
  });

  it('refuses an argument with the usage exit code, and checks nothing', async () => {
    const result = await doctor({ nodeVersion: '24.0.0', args: ['--fix'] });

    expect(result).toEqual({
      code: 2,
      out: '',
      err: '"sheavly doctor" takes no arguments, got "--fix". Run "sheavly doctor --help".\n',
    });
  });

  it('answers --help without checking anything', async () => {
    const result = await doctor({ nodeVersion: '1.0.0', args: ['--help'] });

    expect(result.code).toBe(0);
    expect(result.out).toContain('Usage: sheavly doctor');
  });
});

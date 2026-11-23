import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { profileIdSchema } from '@sheavly/protocol/profile/profile.validator';
import { ConfigStore } from '@sheavly/storage/config-store/config-store.service';
import { ProfileStore } from '@sheavly/storage/profile-store/profile-store.service';
import { checkProfile } from '../profile-check.helper.js';
import { renderReport } from '../report.utils.js';

const SECRET = 'sk-planted-in-a-file-doctor-must-not-print';
const WORK = profileIdSchema.parse('00000000-0000-4000-8000-000000000001');
const GONE = profileIdSchema.parse('00000000-0000-4000-8000-000000000009');
let home: string;

beforeEach(async () => {
  home = await mkdtemp(path.join(tmpdir(), 'doctor-profile-'));
});

afterEach(async () => {
  await rm(home, { recursive: true, force: true });
});

describe('doctor checks the profile', () => {
  it('fails with no profile, says to set one up, and makes nothing', async () => {
    const found = await checkProfile({ home });

    expect(found.ok).toBe(false);
    expect(found.lines).toEqual(['no profile is set up', '  Run `sheavly setup` to set one up.']);
    await expect(rm(path.join(home, 'profiles'))).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('fails for a home that does not exist, as no profile', async () => {
    const found = await checkProfile({ home: path.join(home, 'nothing') });

    expect(found.lines[0]).toBe('no profile is set up');
  });

  it('is ok when the config names a default profile that reads', async () => {
    await new ProfileStore({ root: home }).put({ id: WORK, name: 'Work' });
    await new ConfigStore({ root: home }).setDefaultProfile(WORK);

    expect(await checkProfile({ home })).toEqual({
      label: 'Profile',
      ok: true,
      lines: [`default profile ${WORK} (1 set up)`],
    });
  });

  it('fails when profiles exist but none is the default', async () => {
    await new ProfileStore({ root: home }).put({ id: WORK, name: 'Work' });

    const found = await checkProfile({ home });

    expect(found.ok).toBe(false);
    expect(found.lines[0]).toBe('1 profile(s) but none is the default');
  });

  it('fails when the default names a profile that is gone', async () => {
    await new ProfileStore({ root: home }).put({ id: WORK, name: 'Work' });
    await new ConfigStore({ root: home }).setDefaultProfile(GONE);

    const found = await checkProfile({ home });

    expect(found.ok).toBe(false);
    expect(found.lines[0]).toBe(`the default profile ${GONE} does not exist or cannot be read`);
  });

  it('fails and names a profile folder that cannot be read, even beside a good default', async () => {
    await new ProfileStore({ root: home }).put({ id: WORK, name: 'Work' });
    await new ConfigStore({ root: home }).setDefaultProfile(WORK);

    const damaged = path.join(home, 'profiles', GONE);

    await mkdir(damaged);
    await writeFile(path.join(damaged, 'profile.json'), '{ not json');

    const found = await checkProfile({ home });

    expect(found.ok).toBe(false);
    expect(found.lines[0]).toBe(`default profile ${WORK} (1 set up)`);
    expect(found.lines.join('\n')).toContain(damaged);
  });

  it('reports a config it cannot read as a finding, not a crash', async () => {
    await writeFile(path.join(home, 'config.json'), '{ not json');

    const found = await checkProfile({ home });

    expect(found.ok).toBe(false);
    expect(found.lines[0]).toContain('config.json');
  });

  it('names a config it cannot read but never quotes what it holds', async () => {
    await writeFile(path.join(home, 'config.json'), `{ "apiKey": "${SECRET}", not json`);

    const found = await checkProfile({ home });

    expect(found.lines).toEqual([`${path.join(home, 'config.json')} cannot be read`]);
  });

  it('names a profile whose file does not match the format, without the values in it', async () => {
    const folder = path.join(home, 'profiles', GONE);

    await mkdir(folder, { recursive: true });
    await writeFile(path.join(folder, 'profile.json'), JSON.stringify({ id: 7, key: SECRET }));

    const found = await checkProfile({ home });

    expect(found.ok).toBe(false);
    expect(found.lines.join('\n')).toContain(folder);
    expect(found.lines.join('\n')).not.toContain(SECRET);
  });

  it('prints a profile folder named with an escape sequence and a line break as plain text', async () => {
    const hostile = 'x\nok    Server  running and verified\u001b]0;pwned\u0007';

    await mkdir(path.join(home, 'profiles', hostile), { recursive: true });

    const report = renderReport([await checkProfile({ home })]);

    expect(report.includes('\u001b') || report.includes('\u0007')).toBe(false);
    expect(report.split('\n').filter((line) => line.startsWith('ok'))).toEqual([]);
  });

  it('reports a home that is not an absolute path as a finding', async () => {
    const found = await checkProfile({ home: 'relative/home' });

    expect(found.ok).toBe(false);
    expect(found.lines).toEqual(['the home is not a folder Sheavly can use']);
  });
});

import { chmod, mkdir, mkdtemp, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { checkHome } from '../home-check.helper.js';

const uid = process.getuid?.() ?? 0;
let base: string;

beforeEach(async () => {
  base = await mkdtemp(path.join(tmpdir(), 'doctor-home-'));
});

afterEach(async () => {
  await chmod(base, 0o700);
  await rm(base, { recursive: true, force: true });
});

async function home(mode: number): Promise<string> {
  const folder = path.join(base, 'home');

  await mkdir(folder);
  await chmod(folder, mode);

  return folder;
}

describe.skipIf(process.platform === 'win32')('doctor checks the home folder', () => {
  it('is ok for a private folder you can write to', async () => {
    const folder = await home(0o700);

    expect(await checkHome({ home: folder, uid, platform: process.platform })).toEqual({
      label: 'Home',
      ok: true,
      lines: [`${folder} (private, writable)`],
    });
  });

  it('follows a home that is a link, as the server does', async () => {
    const folder = await home(0o700);
    const link = path.join(base, 'link');

    await symlink(folder, link);

    expect((await checkHome({ home: link, uid, platform: process.platform })).ok).toBe(true);
  });

  it('fails a folder others can open, and says to make it private', async () => {
    const found = await checkHome({
      home: await home(0o755),
      uid,
      platform: process.platform,
    });

    expect(found.ok).toBe(false);
    expect(found.lines.join('\n')).toContain('others can open it');
  });

  it('fails a folder that belongs to another user', async () => {
    const found = await checkHome({
      home: await home(0o700),
      uid: uid + 1,
      platform: process.platform,
    });

    expect(found.ok).toBe(false);
    expect(found.lines.join('\n')).toContain('belongs to another user');
  });

  it.skipIf(uid === 0)('fails a folder you cannot write to', async () => {
    const found = await checkHome({
      home: await home(0o500),
      uid,
      platform: process.platform,
    });

    expect(found.ok).toBe(false);
    expect(found.lines.join('\n')).toContain('cannot write');
  });

  it('fails a home that is a file', async () => {
    const file = path.join(base, 'file');

    await writeFile(file, '');

    const found = await checkHome({ home: file, uid, platform: process.platform });

    expect(found.ok).toBe(false);
    expect(found.lines.join('\n')).toContain('not a folder');
  });

  it('says a home that does not exist yet is not there, without failing or making it', async () => {
    const missing = path.join(base, 'nothing');
    const found = await checkHome({ home: missing, uid, platform: process.platform });

    expect(found.ok).toBe(true);
    expect(found.lines[0]).toBe(`${missing} does not exist yet (the first setup makes it)`);
    await expect(stat(missing)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('fails a link to a folder that is gone, which is not "does not exist yet"', async () => {
    const link = path.join(base, 'link');

    await symlink(path.join(base, 'gone'), link);

    const found = await checkHome({ home: link, uid, platform: process.platform });

    expect(found.ok).toBe(false);
    expect(found.lines.join('\n')).toContain('a link to a folder that is gone');
  });

  it('fails a home below a file, which no setup can make', async () => {
    const file = path.join(base, 'file');

    await writeFile(file, '');

    const found = await checkHome({
      home: path.join(file, 'home'),
      uid,
      platform: process.platform,
    });

    expect(found.ok).toBe(false);
    expect(found.lines.join('\n')).toContain('a folder in its path is a file');
  });

  it('does not judge owner or mode on Windows', async () => {
    const found = await checkHome({ home: await home(0o755), uid: uid + 1, platform: 'win32' });

    expect(found.ok).toBe(true);
  });
});

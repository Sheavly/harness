import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { VersionError } from '../../errors/cli.errors.js';
import { readCliVersion } from '../version.helper.js';

let folder: string | undefined;

afterEach(async () => {
  if (folder) await rm(folder, { recursive: true, force: true });
  folder = undefined;
});

async function packageFile(content: string): Promise<URL> {
  folder = await mkdtemp(path.join(tmpdir(), 'cli-version-'));

  const file = path.join(folder, 'package.json');

  await writeFile(file, content);

  return pathToFileURL(file);
}

describe('readCliVersion', () => {
  it('reads the version of the command line’s own package.json by default', async () => {
    expect(await readCliVersion()).toMatch(/^\d+\.\d+\.\d+/);
  });

  it('reads the version of the file it is given', async () => {
    expect(await readCliVersion(await packageFile('{"version":"4.5.6"}'))).toBe('4.5.6');
  });

  it('throws a VersionError for a file that is missing, not JSON, or has no version', async () => {
    const missing = pathToFileURL(path.join(tmpdir(), 'cli-version-missing', 'package.json'));

    await expect(readCliVersion(missing)).rejects.toBeInstanceOf(VersionError);
    await expect(readCliVersion(await packageFile('not json'))).rejects.toBeInstanceOf(
      VersionError,
    );
    await expect(readCliVersion(await packageFile('{"name":"x"}'))).rejects.toThrow(
      'has no version',
    );
  });
});

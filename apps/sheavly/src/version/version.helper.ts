import { readFile } from 'node:fs/promises';
import { VersionError } from '../errors/cli.errors.js';
import { CLI_PACKAGE_FILE } from './version.constants.js';
import { parsePackageVersion } from './version.validator.js';

/**
 * The command line's own version: the `version` of its `package.json`, read when asked for
 * (`file` defaults to that package's own). Throws when the file cannot be read or has no version.
 */
export async function readCliVersion(
  file: URL = new URL(CLI_PACKAGE_FILE, import.meta.url),
): Promise<string> {
  let json: unknown;

  try {
    json = JSON.parse(await readFile(file, 'utf8'));
  } catch (caughtError) {
    throw new VersionError({
      message: `Could not read the version from ${file.pathname}`,
      file: file.pathname,
      cause: caughtError,
    });
  }

  return parsePackageVersion({ json, file: file.pathname });
}

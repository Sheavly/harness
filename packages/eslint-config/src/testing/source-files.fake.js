// Test-only: the source files of a workspace folder, read from disk, so a confinement test covers
// a new file without an edit.
import { readdirSync } from 'node:fs';
import path from 'node:path';

/**
 * Every file under `folder` of the workspace at `root`, as a path relative to `root`, with the
 * `__tests__` and `testing` folders left out.
 */
export function sourceFilesUnder(params) {
  const { root, folder } = params;

  return readdirSync(path.join(root, folder), { withFileTypes: true }).flatMap((entry) => {
    const relative = `${folder}/${entry.name}`;

    if (!entry.isDirectory()) return [relative];

    return entry.name === '__tests__' || entry.name === 'testing'
      ? []
      : sourceFilesUnder({ root, folder: relative });
  });
}

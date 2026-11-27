import path from 'node:path';
import { ESLint } from 'eslint';
import { expect } from 'vitest';

const SHEAVLY = path.resolve(import.meta.dirname, '../../../../apps/sheavly');
const eslint = new ESLint({ cwd: SHEAVLY });

/**
 * Test-only: the messages of `rule` (`no-restricted-imports` unless another is named) that the
 * launcher's real config reports for `code` written as `file`, a path inside `apps/sheavly`. The
 * file is told apart by where it is, so it should exist for the typed rules to read.
 */
export async function launcherReports(params) {
  const { code, file, rule = 'no-restricted-imports' } = params;
  const [result] = await eslint.lintText(code, { filePath: path.join(SHEAVLY, file) });

  return result.messages.filter(({ ruleId }) => ruleId === rule);
}

/**
 * Test-only: builds the launcher's typed lint program now. A test file calls it once in a
 * `beforeAll` with a limit of its own: the first lint of any file builds the program, with the
 * sources the launcher imports (the terminal's, the client's), so it is most of a file's time and
 * grows with them, and left alone it counts against the first test's limit.
 */
export const warmLauncherLint = () => launcherReports({ code: '', file: 'src/cli.ts' });

/**
 * Test-only: fails unless the launcher's real config reports `code` once under `rule` (as
 * `launcherReports`), with `why` in the message, in every one of `files`.
 */
export async function expectRefusedIn(params) {
  const { code, files, why, rule } = params;

  for (const file of files) {
    const messages = await launcherReports({ code, file, ...(rule && { rule }) });

    expect(messages, file).toHaveLength(1);
    expect(messages[0].message, file).toContain(why);
  }
}

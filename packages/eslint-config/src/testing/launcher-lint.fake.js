import path from 'node:path';
import { ESLint } from 'eslint';

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

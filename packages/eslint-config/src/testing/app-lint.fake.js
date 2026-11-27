import path from 'node:path';
import { ESLint } from 'eslint';

/**
 * Test-only: lints snippets through the real config of the app `app` (a folder of `apps/`), which
 * a confinement block is spread into. `reports` gives the messages of `rule`
 * (`no-restricted-imports` unless another is named) for `code` written as `file`, a path inside
 * the app; the file is told apart by where it is, so it should exist for the typed rules to read.
 * `warm` builds the app's typed lint program now: the first lint of any file builds it, with the
 * sources the app imports, so it is most of a test file's time and, left alone, counts against the
 * first test's limit.
 */
export function lintApp(params) {
  const { app } = params;
  const root = path.resolve(import.meta.dirname, '../../../../apps', app);
  const eslint = new ESLint({ cwd: root });

  async function reports(options) {
    const { code, file, rule = 'no-restricted-imports' } = options;
    const [result] = await eslint.lintText(code, { filePath: path.join(root, file) });

    return result.messages.filter(({ ruleId }) => ruleId === rule);
  }

  return { reports, warm: (file) => reports({ code: '', file }) };
}

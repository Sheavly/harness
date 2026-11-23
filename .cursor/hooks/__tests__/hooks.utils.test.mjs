import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { formatTurboReport, hookNow, PROJECT_ROOT, repoRoot, sameRepo } from '../hooks.utils.mjs';
import { formatEslintReport } from '../lint-report.utils.mjs';

it('reads integer epoch milliseconds without installing a clock library', () => {
  const at = hookNow();

  expect(Number.isSafeInteger(at)).toBe(true);
  expect(at).toBeGreaterThan(1_700_000_000_000);
  expect(hookNow()).toBeGreaterThanOrEqual(at);
});

describe('formatEslintReport', () => {
  const report = (ruleId) =>
    JSON.stringify([
      {
        filePath: path.join(PROJECT_ROOT, 'src/a.ts'),
        messages: [{ line: 3, column: 5, message: 'Too deep.', ruleId }],
      },
    ]);

  it("adds the rule's hint under a problem from a rule that has one", () => {
    const [problem] = formatEslintReport(report('max-depth'));

    expect(problem).toMatch(/^src\/a\.ts:3:5 {2}Too deep\. {2}\(max-depth\)\n {2}→ Flatten/);
  });

  it('reports a rule without a hint, and a parse error, on one line', () => {
    expect(formatEslintReport(report('eqeqeq'))).toEqual(['src/a.ts:3:5  Too deep.  (eqeqeq)']);
    expect(formatEslintReport(report(null))).toEqual(['src/a.ts:3:5  Too deep.  (parse error)']);
  });
});

// Shaped like `turbo run … --continue --output-logs=errors-only` with a failing typecheck.
const FAILED_RUN = [
  '',
  '   • turbo 2.11.10',
  '   • Running typecheck, typecheck:root in 4 packages',
  '',
  '@sheavly/core:typecheck: cache miss, executing dcc3ee5c8d6f8a66',
  '@sheavly/core:typecheck: npm notice run tsc --noEmit',
  "@sheavly/core:typecheck: src/a.ts(1,14): error TS2322: Type 'string' is not assignable.",
  '@sheavly/core:typecheck: npm error Lifecycle script `typecheck` failed with error:',
  '@sheavly/core:typecheck: ',
  '@sheavly/core#typecheck:  WARNING  command finished with error, but continuing...',
  '//:typecheck:root: src/b.ts(2,1): error TS2304: Cannot find name x.',
  '//#typecheck:root:  WARNING  command finished with error, but continuing...',
  '@sheavly/core#typecheck:  ERROR  command (/repo/packages/core) npm run typecheck exited (2)',
  '',
  ' Tasks:    2 successful, 4 total',
  'Failed:    //#typecheck:root, @sheavly/core#typecheck',
  '',
  ' ERROR  run failed: command  exited (2)',
].join('\n');

describe('formatTurboReport', () => {
  it("keeps the failing tasks' own output and the Failed: line", () => {
    expect(formatTurboReport(FAILED_RUN).split('\n')).toEqual([
      "@sheavly/core:typecheck: src/a.ts(1,14): error TS2322: Type 'string' is not assignable.",
      '//:typecheck:root: src/b.ts(2,1): error TS2304: Cannot find name x.',
      'Failed:    //#typecheck:root, @sheavly/core#typecheck',
    ]);
  });

  it('strips colors before matching', () => {
    expect(formatTurboReport('\u001B[31m@sheavly/core:lint: 1:1  error  x\u001B[0m')).toBe(
      '@sheavly/core:lint: 1:1  error  x',
    );
  });

  it('returns the whole output when turbo failed before any task ran', () => {
    const output = '  x Could not resolve workspaces.\n  `-> Missing `packageManager` field';

    expect(formatTurboReport(output)).toBe(output);
  });
});

describe('repoRoot', () => {
  const made = [];

  afterEach(() => {
    for (const dir of made.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  /** A temp folder, with its real path (a temp folder may sit behind a link). */
  const folder = () => {
    const dir = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'hook-root-')));

    made.push(dir);

    return dir;
  };

  it('is the top folder of the checkout a folder is in, from the top or from below it', () => {
    const dir = folder();

    spawnSync('git', ['init', '-q'], { cwd: dir });
    mkdirSync(path.join(dir, 'packages', 'loop'), { recursive: true });

    expect(repoRoot(dir)).toBe(dir);
    expect(repoRoot(path.join(dir, 'packages', 'loop'))).toBe(dir);
  });

  it('is the worktree’s own top folder, not the repo it belongs to', () => {
    const main = folder();
    const worktree = path.join(folder(), 'wt');

    spawnSync('git', ['init', '-q', '-b', 'main'], { cwd: main });
    spawnSync(
      'git',
      ['-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '--allow-empty', '-m', 'x'],
      {
        cwd: main,
      },
    );
    spawnSync('git', ['worktree', 'add', '-q', '-b', '13-other', worktree], { cwd: main });

    expect(repoRoot(worktree)).toBe(realpathSync(worktree));
    expect(repoRoot(main)).toBe(main);
  });

  it('is null for a folder that is not in a repo, and for one that does not exist', () => {
    expect(repoRoot(folder())).toBeNull();
    expect(repoRoot(path.join(folder(), 'missing'))).toBeNull();
  });

  describe('sameRepo', () => {
    const initRepo = () => {
      const dir = folder();

      spawnSync('git', ['init', '-q', '-b', 'main'], { cwd: dir });
      spawnSync(
        'git',
        ['-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '--allow-empty', '-m', 'x'],
        { cwd: dir },
      );

      return dir;
    };

    it('holds for a checkout and its worktrees, and for two folders of one checkout', () => {
      const main = initRepo();
      const worktree = path.join(folder(), 'wt');

      spawnSync('git', ['worktree', 'add', '-q', '-b', '13-other', worktree], { cwd: main });
      mkdirSync(path.join(main, 'packages', 'loop'), { recursive: true });

      expect(sameRepo(main, worktree)).toBe(true);
      expect(sameRepo(worktree, main)).toBe(true);
      expect(sameRepo(main, path.join(main, 'packages', 'loop'))).toBe(true);
    });

    it('does not hold for two repositories, even with the same branch and files', () => {
      expect(sameRepo(initRepo(), initRepo())).toBe(false);
    });

    it('does not hold when either folder is not in a repo or does not exist', () => {
      const main = initRepo();

      expect(sameRepo(main, folder())).toBe(false);
      expect(sameRepo(folder(), main)).toBe(false);
      expect(sameRepo(main, path.join(folder(), 'missing'))).toBe(false);
    });
  });
});

// Shared helpers for the Cursor hooks in this folder. Hooks talk JSON over stdin/stdout:
// Cursor writes the event payload to stdin and reads our response from stdout.
import { spawnSync } from 'node:child_process';
import { realpathSync } from 'node:fs';
import path from 'node:path';
import { stripVTControlCharacters } from 'node:util';
import { performance } from 'node:perf_hooks';
import { GuardCrashError } from './hooks.errors.mjs';

/** Project hooks run from the project root. */
export const PROJECT_ROOT = process.cwd();

/**
 * Epoch milliseconds anchored to process start, without installed packages. Guards must run
 * before npm ci; this short-lived clock advances monotonically instead of following wall-clock
 * adjustments mid-hook. Tests of state lifetimes pass their own time to the state helpers.
 */
export function hookNow() {
  return Math.floor(performance.timeOrigin + performance.now());
}

/** Files ESLint checks (see eslint.config.js). */
export const LINTABLE = /\.(ts|js|mjs)$/;

/** Files Prettier formats (see .prettierrc.json / .prettierignore). */
export const FORMATTABLE = /\.(ts|js|mjs|json|md)$/;

export async function readHookInput() {
  let raw = '';

  for await (const chunk of process.stdin) raw += chunk;

  return raw ? JSON.parse(raw) : {};
}

export function respond(output) {
  process.stdout.write(JSON.stringify(output));
}

/** Edit tools name their target differently, so accept every known key. */
export function getEditedFilePath(toolInput) {
  const input = typeof toolInput === 'string' ? JSON.parse(toolInput) : (toolInput ?? {});
  const candidate = input.file_path ?? input.path ?? input.target_file;

  if (typeof candidate !== 'string') return null;

  return path.resolve(PROJECT_ROOT, candidate);
}

/** Inside the project and not in node_modules or build output. */
export function isProjectSource(filePath) {
  const relative = path.relative(PROJECT_ROOT, filePath);

  if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    return false;
  }

  return !/^(node_modules|dist|coverage)[/\\]/.test(relative);
}

/** Runs a project-local binary (node_modules/.bin) and captures its output; never throws. */
export function runBin(name, args) {
  return runFile(path.join(PROJECT_ROOT, 'node_modules', '.bin', name), args);
}

/** Runs an npm script quietly (so its own config and wrappers apply); never throws. */
export function runNpmScript(name) {
  return runFile('npm', ['run', '--silent', name]);
}

/** The checked-out branch in `cwd`, or null (detached HEAD, not a repo). */
export function currentBranch(cwd = PROJECT_ROOT) {
  const result = spawnSync('git', ['branch', '--show-current'], { cwd, encoding: 'utf8' });
  const branch = result.status === 0 ? result.stdout.trim() : '';

  return branch || null;
}

/**
 * The top folder of the git checkout that `dir` is in, or null (not a repo, or no such folder).
 * Hooks run from the folder the session was started in, which is not always the checkout a command
 * acts on (a worktree of the same repo): rules that read the repo's files or branch read this one.
 */
export function repoRoot(dir) {
  const result = spawnSync('git', ['rev-parse', '--show-toplevel'], { cwd: dir, encoding: 'utf8' });
  const root = result.status === 0 ? result.stdout.trim() : '';

  return root || null;
}

/** The git directory the checkouts of one repository share, or null (not a repo). */
function commonGitDir(dir) {
  const result = spawnSync('git', ['rev-parse', '--path-format=absolute', '--git-common-dir'], {
    cwd: dir,
    encoding: 'utf8',
  });
  const common = result.status === 0 ? result.stdout.trim() : '';

  return common ? realpathSync(common) : null;
}

/**
 * Whether two folders are checkouts of the same repository: the folder itself and its worktrees
 * share one git directory. A command that names another checkout is believed only when it is one
 * of these, so a repository made for the purpose, with a branch and packages of its choosing,
 * does not decide what a commit is checked against.
 */
export function sameRepo(first, second) {
  const common = commonGitDir(first);

  return common !== null && common === commonGitDir(second);
}

function runFile(file, args) {
  const result = spawnSync(file, args, {
    cwd: PROJECT_ROOT,
    encoding: 'utf8',
    maxBuffer: 20 * 1024 * 1024,
  });
  const output = `${result.stdout ?? ''}${result.stderr ?? ''}`.trim();

  // It never started (missing binary, no permission): say so, rather than an empty failure.
  if (result.error) return { ok: false, output: `Could not run ${file}: ${result.error.message}` };

  return { ok: result.status === 0, output };
}

/**
 * Runs a guard hook's `check` and responds with its decision. If the guard itself fails, it
 * denies with a `GuardCrashError` saying why, so a broken guard never lets an action through
 * silently (`failClosed` in hooks.json covers a crash before this runs).
 */
export async function runGuard(params) {
  const { guard, check, deny } = params;

  try {
    respond(await check());
  } catch (caughtError) {
    respond(deny(new GuardCrashError({ guard, cause: caughtError }).message));
  }
}

/** A task's own line: `@sheavly/core:lint: …` (the root package is `//`), not turbo's `pkg#task:`. */
const TURBO_TASK_LINE = /^[^\s#]+:\S+: (.*)$/;
/** What npm and turbo add around a task's own output. */
const TURBO_NOISE = /^(npm (notice|error) |cache (miss|hit|bypass)|\s*$)/;

/**
 * turbo's `--output-logs=errors-only` report cut to what the failing tasks' tools printed (no npm
 * lifecycle lines, no turbo progress), plus its `Failed:` line. Falls back to the whole output
 * when it has no task line in it (turbo itself failed to start).
 */
export function formatTurboReport(output) {
  const kept = [];

  for (const line of stripVTControlCharacters(output).split('\n')) {
    const task = TURBO_TASK_LINE.exec(line);

    if (task && !TURBO_NOISE.test(task[1] ?? '')) kept.push(line);
    else if (line.startsWith('Failed:')) kept.push(line.trim());
  }

  return kept.length > 0 ? kept.join('\n') : output;
}

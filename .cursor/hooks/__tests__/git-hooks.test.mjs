import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { runHook as runHookIn } from './run-hook.utils.mjs';

const ROOT = path.resolve(import.meta.dirname, '../../..');
let stateDir = '';
let repo = '';
/** Other checkouts a test made, removed after it. */
let others = [];

function git(...args) {
  spawnSync('git', args, { cwd: repo, encoding: 'utf8' });
}

/** A commit scope in `dir`: a package folder with a `package.json`, as the guard reads them. */
function addPackage(dir, name) {
  mkdirSync(path.join(dir, 'packages', name), { recursive: true });
  writeFileSync(path.join(dir, 'packages', name, 'package.json'), '{}');
}

/** A worktree of `repo` on a new `branch`, with the packages in `scopes` on disk. */
function otherCheckout(params) {
  const { branch, scopes } = params;
  const parent = mkdtempSync(path.join(os.tmpdir(), 'hook-other-'));
  const dir = path.join(parent, 'wt');

  others.push(parent);
  // A worktree needs a commit to start from.
  git('-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '--allow-empty', '-m', 'init');
  git('worktree', 'add', '-q', '-b', branch, dir);

  for (const scope of scopes) addPackage(dir, scope);

  return dir;
}

/** A repository of its own, not a worktree of `repo`, on `branch`, with the packages in `scopes`. */
function unrelatedRepo(params) {
  const { branch, scopes } = params;
  const dir = mkdtempSync(path.join(os.tmpdir(), 'hook-unrelated-'));

  others.push(dir);
  spawnSync('git', ['init', '-q', '-b', branch], { cwd: dir, encoding: 'utf8' });

  for (const scope of scopes) addPackage(dir, scope);

  return dir;
}

/** Runs a hook script with `input` on stdin, against the temp state dir; returns its response. */
function runHook(params) {
  return runHookIn({ ...params, cwd: ROOT, stateDir });
}

const prompt = (text, extra = {}) =>
  runHook({
    script: 'require-issue.mjs',
    input: { conversation_id: 'c1', prompt: text, workspace_roots: [repo], ...extra },
  });
const shell = (command) =>
  runHook({
    script: 'guard-git-workflow.mjs',
    input: { conversation_id: 'c1', command, cwd: repo },
  });

beforeEach(() => {
  stateDir = mkdtempSync(path.join(os.tmpdir(), 'hook-state-'));
  repo = mkdtempSync(path.join(os.tmpdir(), 'hook-repo-'));
  git('init', '-q', '-b', 'main');
});

afterEach(() => {
  rmSync(stateDir, { recursive: true, force: true });
  rmSync(repo, { recursive: true, force: true });

  for (const dir of others) rmSync(dir, { recursive: true, force: true });

  others = [];
});

describe('the issue gate', () => {
  it('blocks a first prompt that names no issue, and remembers one that does', () => {
    expect(prompt('add export')).toMatchObject({ continue: false });
    expect(prompt('#12: add export')).toEqual({ continue: true });
    expect(prompt('and now the tests')).toEqual({ continue: true });
  });

  it('takes the issue from the checked-out branch, in any new chat', () => {
    git('switch', '-q', '-c', '12-export');
    expect(prompt('carry on')).toEqual({ continue: true });
    expect(prompt('fix a typo', { conversation_id: 'c2' })).toEqual({ continue: true });
  });

  it('lets NO-ISSUE and Ask mode through', () => {
    expect(prompt('NO-ISSUE fix a typo')).toEqual({ continue: true });
    expect(prompt('explain this', { conversation_id: 'c3', composer_mode: 'ask' })).toEqual({
      continue: true,
    });
  });

  it('lets a NO-ISSUE chat name an issue later, to create its branch', () => {
    prompt('NO-ISSUE look around');
    expect(shell('git switch -c 12-export')).toMatchObject({ permission: 'deny' });
    prompt('now work on #12');
    expect(shell('git switch -c 12-export')).toEqual({ permission: 'allow' });
  });
});

describe('stacked PRs', () => {
  beforeEach(() => {
    prompt('a stack: #12 and #13');
  });

  it.each([
    'git switch -c 12-switch-contract',
    'git switch -c 12-switch-loop 12-switch-contract',
    'git switch -c 13-switch-ui',
    'gh stack init --base main 12-switch-contract',
    'gh stack init 12-switch-contract 12-switch-loop 13-switch-ui',
    'gh stack add 12-switch-loop',
    'gh stack submit --auto',
    'gh stack view --json',
    'gh stack merge 45 --yes --squash',
    'gh stack rebase --upstack',
    'gh stack push',
    'gh stack sync --prune',
    'gh stack checkout 12-switch-loop',
    'gh stack up',
    'gh pr create --draft --base 12-switch-contract --head 12-switch-loop --title x --body-file /tmp/b',
    'gh pr edit 46 --base main',
  ])('allows %j', (command) => {
    expect(shell(command)).toEqual({ permission: 'allow' });
  });

  it.each([
    'git switch -c 14-other',
    'gh stack add 14-other',
    'gh stack add',
    'gh stack add -Am "wip" 12-x',
    'gh stack init',
    'gh stack init --base develop 12-x',
    'gh stack submit',
    'gh stack view',
    'gh stack merge 45',
    'gh stack modify',
    'gh stack switch',
    'gh stack checkout',
  ])('denies %j', (command) => {
    expect(shell(command)).toMatchObject({ permission: 'deny' });
  });

  it('says how an issue is registered when it denies a branch for another one', () => {
    const message = shell('git switch -c 14-other').agent_message;

    expect(message).toContain('Only prompts the user typed are scanned');
    expect(message).toContain('`#14` or an `/issues/14` URL');
    expect(message).toContain('ask the user to repeat `#14` in a new prompt');
    expect(message).not.toContain('check out');
  });

  it('adds issues named in later prompts to the stack', () => {
    prompt('and #14 on top');
    expect(shell('gh stack add 14-other')).toEqual({ permission: 'allow' });
  });
});

describe('the git guard', () => {
  beforeEach(() => {
    prompt('#12: add export');
  });

  it.each([
    'git add -A',
    'git add .',
    'git commit -am "x"',
    'git push --force',
    'git push -f origin 12-export',
    'gh pr merge 4',
    'gh pr merge 4 --merge',
    'git cherry-pick abc123',
    'git switch -c road-export',
    'git checkout -b 13-other-issue',
    'gh issue develop 12 --name export',
    'git commit',
    'git commit -m "Add export"',
  ])('denies %j', (command) => {
    expect(shell(command)).toMatchObject({ permission: 'deny' });
  });

  it.each([
    'git add src/a.ts src/b.ts',
    'git push --force-with-lease',
    'gh pr merge 4 --squash --delete-branch',
    'git switch -c 12-export',
    'gh issue develop 12 --name 12-export --base main --checkout',
    'git status && git log --oneline',
    'git cherry-pick --abort',
    'gh pr create --title "feat: git add -A is mentioned here" --body x',
  ])('allows %j', (command) => {
    expect(shell(command)).toEqual({ permission: 'allow' });
  });

  it("checks a commit's message and its Refs against the branch's issue", () => {
    git('switch', '-q', '-c', '12-export');
    addPackage(repo, 'loop');
    const commit = (message) => shell(`git commit -m "$(cat <<'EOF'\n${message}\nEOF\n)"`);

    expect(commit('feat(loop): add export\n\nRefs: #12')).toEqual({ permission: 'allow' });
    expect(commit('feat(loop): add export\n\nRefs: #13')).toMatchObject({ permission: 'deny' });
    expect(commit('feat(loop): add export')).toMatchObject({ permission: 'deny' });
  });

  describe('a commit made in another checkout of the repo', () => {
    // The session starts in `repo` (branch 12-export, scope `loop`); the commit lands in a worktree
    // with its own branch and its own packages, so that is the one the message is checked against.
    const message = (text) => `<<'EOF'\n${text}\nEOF\n`;
    const commitIn = (prefix, text) => shell(`${prefix} commit -m "$(cat ${message(text)})"`);

    beforeEach(() => {
      git('switch', '-q', '-c', '12-export');
      addPackage(repo, 'loop');
    });

    it.each([
      ['git -C', (dir) => `git -C ${dir}`],
      ['a leading cd', (dir) => `cd ${dir} && git`],
    ])("reads the other checkout's branch and scopes with %s", (_name, prefix) => {
      const dir = otherCheckout({ branch: '13-other', scopes: ['tools'] });

      expect(commitIn(prefix(dir), 'feat(tools): add it\n\nRefs: #13')).toEqual({
        permission: 'allow',
      });
      // The session's own branch (12) and scope (loop) are not what counts here.
      expect(commitIn(prefix(dir), 'feat(tools): add it\n\nRefs: #12')).toMatchObject({
        permission: 'deny',
      });
      expect(commitIn(prefix(dir), 'feat(loop): add it\n\nRefs: #13')).toMatchObject({
        permission: 'deny',
      });
    });

    it('names the other checkout in the message when the issue is wrong', () => {
      const dir = otherCheckout({ branch: '13-other', scopes: ['tools'] });
      const response = commitIn(`git -C ${dir}`, 'feat(tools): add it\n\nRefs: #12');

      expect(response.agent_message).toContain('branch 13-other of ');
    });

    it('still checks a plain commit against the session’s own checkout', () => {
      otherCheckout({ branch: '13-other', scopes: ['tools'] });

      expect(commitIn('git', 'feat(loop): add it\n\nRefs: #12')).toEqual({ permission: 'allow' });
      expect(commitIn('git', 'feat(tools): add it\n\nRefs: #12')).toMatchObject({
        permission: 'deny',
      });
    });

    it.each([
      ['git -C', (dir) => `git -C ${dir}`],
      ['a leading cd', (dir) => `cd ${dir} && git`],
    ])(
      'does not believe a repository that is not a worktree of the session’s, with %s',
      (_name, prefix) => {
        // A repository made for the purpose, on a branch and with packages of its choosing: what it
        // says counts for nothing, the message is checked against the session's own checkout.
        const dir = unrelatedRepo({ branch: '13-other', scopes: ['tools'] });

        expect(commitIn(prefix(dir), 'feat(tools): add it\n\nRefs: #13')).toMatchObject({
          permission: 'deny',
        });
        expect(commitIn(prefix(dir), 'feat(loop): add it\n\nRefs: #12')).toEqual({
          permission: 'allow',
        });
      },
    );
  });

  it('allows a cherry-pick once the user wrote "allow cherry-pick"', () => {
    prompt('ok, allow cherry-pick of abc123 onto 12-export');
    expect(shell('git cherry-pick abc123')).toEqual({ permission: 'allow' });
  });

  it.each([
    ['gh issue create --type Task --title "Add export" --body-file /tmp/b', 'deny'],
    ['gh issue create --title x --label documentation --body-file /tmp/b', 'deny'],
    ['gh issue create --title x --label area/tools --body-file /tmp/b', 'allow'],
    ['gh issue create --title x -l security,area/runtime --body-file /tmp/b', 'allow'],
    ['gh issue create --title x --label=documentation --label=area/loop', 'allow'],
    ['gh issue create --help', 'allow'],
  ])('needs an area label to create an issue: %j', (command, permission) => {
    expect(shell(command)).toMatchObject({ permission });
  });
});

describe('a guard that fails', () => {
  // A corrupt chat state makes both guards crash while deciding: each denies, saying why.
  beforeEach(() => writeFileSync(path.join(stateDir, 'c1.json'), '{ not json'));

  it('denies a shell command, naming the corrupt state file', () => {
    const response = shell('git status');

    expect(response).toMatchObject({ permission: 'deny' });
    expect(response.agent_message).toContain('The git workflow guard failed, so it denied');
    expect(response.agent_message).toContain('c1.json could not be read');
  });

  it('stops the prompt, naming the corrupt state file', () => {
    const response = prompt('#12: add export');

    expect(response).toMatchObject({ continue: false });
    expect(response.user_message).toContain('The require-issue guard failed');
    expect(response.user_message).toContain('c1.json could not be read');
  });
});

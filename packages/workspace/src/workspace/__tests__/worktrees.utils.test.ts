import { describe, expect, it } from 'vitest';
import { gitEnv, owningWorktree, parseGitdirFile, parseWorktreePaths } from '../worktrees.utils.js';

describe('parseWorktreePaths', () => {
  it('reads each worktree entry and drops bare ones', () => {
    const output = ['worktree /a', 'HEAD x', 'branch main', '', 'worktree /b', 'bare', ''].join(
      '\0',
    );

    expect(parseWorktreePaths(output)).toEqual(['/a']);
  });

  it('reads nothing from empty output', () => {
    expect(parseWorktreePaths('')).toEqual([]);
  });
});

describe('owningWorktree', () => {
  it('picks the innermost worktree holding the root', () => {
    expect(owningWorktree({ worktrees: ['/r', '/r/nested'], root: '/r/nested/src' })).toBe(
      '/r/nested',
    );
  });

  it('is undefined when none holds the root', () => {
    expect(owningWorktree({ worktrees: ['/x'], root: '/r' })).toBeUndefined();
  });
});

describe('parseGitdirFile', () => {
  it('resolves a relative gitdir against the folder holding the file', () => {
    expect(parseGitdirFile({ content: 'gitdir: ../repo/.git/worktrees/w\n', dir: '/p/w' })).toBe(
      '/p/repo/.git/worktrees/w',
    );
  });

  it('keeps a path whole when a folder name holds U+2028, which is no line end in a .git file', () => {
    expect(parseGitdirFile({ content: 'gitdir: /repo/.git/worktrees/a\u2028b\n', dir: '/p' })).toBe(
      '/repo/.git/worktrees/a\u2028b',
    );
  });

  it('reads a line with a very long run of spaces in it without backtracking over it', () => {
    // A lazy match followed by `\s*` is quadratic here: minutes for a file this size.
    const content = `gitdir: a${' '.repeat(300_000)}b\n`;

    expect(parseGitdirFile({ content, dir: '/p' })?.endsWith('b')).toBe(true);
  });

  it('trims the line and ignores a pointer that holds only spaces', () => {
    expect(parseGitdirFile({ content: 'gitdir:  /x/y \t\r\n', dir: '/p' })).toBe('/x/y');
    expect(parseGitdirFile({ content: 'gitdir:   \n', dir: '/p' })).toBeUndefined();
  });

  it('is undefined for a file that is not a gitdir pointer', () => {
    expect(parseGitdirFile({ content: 'nope', dir: '/p' })).toBeUndefined();
  });
});

describe('gitEnv', () => {
  it('keeps only what git needs, never GIT_DIR or keys', () => {
    const env = { PATH: '/bin', HOME: '/h', GIT_DIR: '/evil', ANTHROPIC_API_KEY: 'k' };

    expect(gitEnv(env)).toEqual({ PATH: '/bin', HOME: '/h' });
  });
});

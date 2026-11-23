import { describe, expect, it } from 'vitest';
import { commitDirectory } from '../shell-parse.utils.mjs';

const CWD = '/work/repo';
const dirOf = (command) => commitDirectory({ command, cwd: CWD }).dir;
const unreadable = (command) => commitDirectory({ command, cwd: CWD }).unreadable;

// The folder a `git commit` runs in decides which branch and which packages its message is
// checked against, so it is read the way git and the shell apply `cd` and `-C`.
describe('commitDirectory', () => {
  it('is the folder the shell starts in when the command moves nowhere', () => {
    expect(dirOf('git commit -m "x"')).toBe(CWD);
    expect(dirOf('git add a.ts && git commit -m "x"')).toBe(CWD);
  });

  it('follows a leading cd, absolute or relative, plain or quoted', () => {
    expect(dirOf('cd /other/wt && git commit -m "x"')).toBe('/other/wt');
    expect(dirOf('cd ../wt && git commit -m "x"')).toBe('/work/wt');
    expect(dirOf('cd "/other/wt"; git commit -m "x"')).toBe('/other/wt');
    expect(dirOf('cd \'/other/wt\' && git commit -m "x"')).toBe('/other/wt');
  });

  it('follows git -C before commit, each one from the one before', () => {
    expect(dirOf('git -C /other/wt commit -m "x"')).toBe('/other/wt');
    expect(dirOf('git -C ../wt commit -m "x"')).toBe('/work/wt');
    expect(dirOf('git -C /a -C b commit -m "x"')).toBe('/a/b');
  });

  it('combines a leading cd with git -C', () => {
    expect(dirOf('cd /a && git -C b commit -m "x"')).toBe('/a/b');
  });

  it('ignores other options of git and -C after the subcommand', () => {
    expect(dirOf('git -c user.name=t commit -m "x"')).toBe(CWD);
    expect(dirOf('git commit -m "x" -C abc123')).toBe(CWD);
    expect(dirOf('git status -C /other')).toBe(CWD);
  });

  it('reads the first commit of the command, and a git on a path', () => {
    expect(dirOf('/usr/bin/git -C /a commit -m "x"')).toBe('/a');
    expect(dirOf('git -C /a commit -m "x" && git -C /b commit -m "y"')).toBe('/a');
  });

  it.each([
    'git -C "/my dir" commit -m "x"',
    'git -C $WT commit -m "x"',
    'git -C "$HOME/wt" commit -m "x"',
    'git -C ~/wt commit -m "x"',
    'git -C /w/* commit -m "x"',
    'cd $WT && git commit -m "x"',
    'cd /a && git -C $B commit -m "x"',
    'git --git-dir=/x/.git commit -m "x"',
  ])(
    'marks a folder it cannot read as unreadable, so the guard asks for it by name: %s',
    (command) => {
      expect(unreadable(command)).toBe(true);
    },
  );

  it('is readable when the command names nothing, or a folder that exists', () => {
    expect(unreadable('git commit -m "x"')).toBe(false);
    expect(commitDirectory({ command: 'git -C /tmp commit -m "x"', cwd: CWD }).unreadable).toBe(
      false,
    );
  });
});

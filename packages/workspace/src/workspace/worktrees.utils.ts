import path from 'node:path';
import { GIT_ENV_KEYS } from './worktrees.constants.js';
import { isInside } from './workspace.utils.js';
import type { Environment } from '@sheavly/core/environment/environment.types';

/** The `worktree <path>` entries of `git worktree list --porcelain -z`, without bare ones. */
export function parseWorktreePaths(output: string): string[] {
  const paths: string[] = [];

  for (const field of output.split('\0')) {
    if (field.startsWith('worktree ')) paths.push(field.slice('worktree '.length));
    // `bare` follows its `worktree` line: a bare repo has no files to work in.
    else if (field === 'bare') paths.pop();
  }

  return paths;
}

/** The innermost worktree holding `root`: a worktree can sit inside another one's folder. */
export function owningWorktree(params: { worktrees: string[]; root: string }): string | undefined {
  const { worktrees, root } = params;
  const holding = worktrees.filter((worktree) => isInside({ folder: worktree, target: root }));

  return holding.sort((a, b) => b.length - a.length)[0];
}

/** Where a `.git` file points: its `gitdir:` line, resolved against the folder holding the file. */
export function parseGitdirFile(params: { content: string; dir: string }): string | undefined {
  const target = /(?:^|[\r\n])gitdir:\s*([^\r\n]+?)\s*(?=[\r\n]|$)/.exec(params.content)?.[1];

  return target ? path.resolve(params.dir, target) : undefined;
}

/** The environment git runs with: `GIT_ENV_KEYS` taken from `env`, nothing else. */
export function gitEnv(env: Environment): Record<string, string> {
  const picked: Record<string, string> = {};

  for (const key of GIT_ENV_KEYS) {
    const value = env[key];

    if (value !== undefined) picked[key] = value;
  }

  return picked;
}

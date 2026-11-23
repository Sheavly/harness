# Troubleshooting

## Rebase conflicts

A rebase (a fold, a reshape or a sync) stops at the commit that conflicts and lists the paths.

1. Resolve each path so the commit keeps its own intent and the change it conflicts with survives.
   If that isn't clear, stop and ask the user.
2. A conflict in `package-lock.json` is never resolved by hand: take `main`'s side, finish the
   rebase, then run `npm install` in the commit that changed `package.json` ([fix.md](fix.md),
   "Fold").
3. `git add <resolved paths>`, then `git rebase --continue`. Repeat for each commit that stops.
4. `git rebase --abort` restores the branch as it was before the rebase. With `rerere` enabled
   ([setup.md](setup.md)), a resolution repeats itself the next time the same conflict comes up.

## A commit is refused for the wrong scope or the wrong issue

`Refs: #466 but branch 393-… is for #393`, or a scope that exists in the branch you are on but
"is not a package": the hooks run from the checkout the session was started in, and the commit
landed in another one (a worktree from [start.md](start.md), step 5b). The guard reads the scopes
and the branch of the checkout the commit is made in, found from `git -C <worktree> commit …`, a
`cd <worktree> &&` (every `cd` before the commit counts, in order), or the shell's own folder, and
its message says which checkout it checked (`branch 12-export of /path`). A folder it cannot read
(a variable, `~`, a space, one that does not exist, `--git-dir`, `--work-tree`) is refused, not
guessed: name it with an absolute `git -C`. So:

- Commit in a worktree with `git -C <worktree> commit …`, and run the other commands there with
  the command's `cwd` or `git -C <worktree>`.
- If the message names the session's own checkout, the command did not name the worktree: add `-C`.
- A guard that still checks the wrong checkout (hook files older than this fix in the checkout the
  session started in) is fixed by updating those hook files there, or by starting the session in
  the worktree. Never skip the hook.

## Push refused

- `rejected … (fetch first)` or `stale info` with `--force-with-lease`: someone else pushed to the
  branch. `git fetch`, look at their commits (`git log HEAD..@{u}`), then rebase onto them
  (`git rebase @{u}`) instead of overwriting them. Never fall back to `--force`.
- `rejected … (non-fast-forward)` on a plain `git push` after a fold or reshape: that is expected;
  push with `--force-with-lease`, and only while the PR is a draft.

## gh can't find the repository

`gh` reads the repo from `origin`. With an SSH host alias (`git@personal.github.com:…`), `gh` may
not map it to github.com: run `gh repo set-default <owner>/<repo>` once, or pass `--repo
<owner>/<repo>`. If it still says not found, the active `gh` account can't see the repo: use the
account that can ([setup.md](setup.md), "Several GitHub accounts"). Check with `gh repo view`.

## The issue didn't close on merge

Closing keywords only act on PRs merged into the default branch, and only from the PR body (or a
commit message). Check `gh pr view <n> --json closingIssuesReferences`; if it's empty the `Closes
#123` line was missing or malformed. Close the issue by hand with a comment naming the PR, if the
user agrees.

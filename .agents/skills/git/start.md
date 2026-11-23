# Start an issue

1. **Read the issue** (preflight step 2). If there is no issue yet, create it first
   ([issues.md](issues.md)).
2. **Triage** the request against it ([triage.md](triage.md)).
3. **Plan the commits**, in the order the work will be built, one scope each:
   - Lower layers first: `core`, then `providers`/`runtime`, then `tools`, then `loop`, then the
     hosts (`host`, `workbook`). A commit only uses what it or an earlier commit adds.
   - Tests go in the commit of the code they test.
   - A doc in `docs/` that describes a scope's change goes in that commit; a doc covering the
     whole feature can be the last commit (`docs: …`).
   - Unrelated work (a separate fix or refactor) belongs under its own issue and PR.
   - Present the plan as a list in review order, with the branch name.
   - If the plan is too big for one PR and its parts depend on each other, propose a stack: the
     plan's commits grouped into layers, one branch and PR each ([stacks.md](stacks.md)). Create
     it there instead of step 5.
4. **Check the starting point:** `git fetch origin main`, then `git status --short --branch`.
   If the current branch is not `main` and is out of sync with `origin/main` (it has commits
   `origin/main` lacks, or uncommitted changes), someone else may be building on it: do not build
   this issue there. Use a new worktree from `origin/main` (step 5b). The exception is a branch
   that is already this issue's own (its name starts with the issue number): continue on it. On
   `main`, or a branch with no commits or changes of its own, the working tree must be clean (or
   the user agrees to carry changes over).
5. **Create the branch** from `main`, named for the task, not for a scope. `gh issue develop`
   links it to the issue:

   ```bash
   gh issue develop 123 --name 123-provider-switch --base main --checkout
   ```

   Without network access, `git switch -c 123-provider-switch origin/main` makes the same branch;
   GitHub links it once the PR's `Closes #123` does.

   **5b. From a branch that is not `main` and is out of sync (step 4)**, create the branch in a
   new worktree in a sibling folder, `../<repo>-<branch>`, instead of switching branches here:

   ```bash
   git worktree add -b 123-provider-switch ../coding-harness-123-provider-switch origin/main
   ```

   Bootstrap it in step 6. GitHub links the branch to the issue once the PR's `Closes #123` does,
   as in the no-network case above. Leave the original checkout as it is.

6. **Bootstrap a separate worktree before moving the session.** From the original initialized
   checkout, run `node scripts/bootstrap-worktree.mjs <worktree-path>`. It runs `npm ci` in the
   target, probes the configured prompt and shell guards with temporary state, and checks the
   installed quality tools. Only after it exits successfully may the OpenCode `session_move`
   tool move this session there. If installation or verification fails, keep the session in the
   original checkout, report the failure, and fix setup there. Never disable hooks to get in.
   Creating a worktree alone is not readiness; prompt submission must work and edit/stop checks
   must have their tools installed. Without a `session_move` tool the session stays in the
   original checkout, and so do its hooks: tell the user which checkout the session is in, work in
   the worktree with the commands' `cwd` or `git -C <worktree>` (the git guard reads the scopes and
   the branch of the checkout the commit is made in; [troubleshooting.md](troubleshooting.md)), and
   check that the hooks the session runs have that rule before the first commit, not after the
   work is done.
7. **Offer** to assign the issue (`gh issue edit 123 --add-assignee @me`) or move it on the project
   board ([issues.md](issues.md)); do it only if the user says yes.
8. **Report** the planned commits and the branch. The next step is to write the first scope's code,
   then `/git commit`. Open the PR as a draft once the first commit is pushed
   ([submit.md](submit.md)), so CI runs from the start.

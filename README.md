# @sheavly/harness

A TypeScript agent loop with pluggable model adapters (OpenAI, Azure).

Design notes for building on the harness are in [docs/](docs/README.md).

## Requirements

- Node 24+
- An OpenAI API key (needed for the default backend, GPT-6.1 Sol)

## 1. Install

```bash
cd ~/projects/coding-harness
npm install
```

## 2. Set up a profile (models and keys)

Your models and keys are yours, kept in `~/.sheavly` (`SHEAVLY_HOME` moves it), never in the
project and never in a `.env`. A **profile** is a bundle of models, their keys and your
conversations (work, personal); each is named by a UUID, and the name inside is only a label.

Until the setup screens and routes exist, a profile is a few small files. Make two UUIDs (one for
the profile, one for the model; `node -e "console.log(crypto.randomUUID())"` prints one) and write:

```text
~/.sheavly/config.json                        { "defaultProfile": "<profile-id>", "workspaces": {} }
~/.sheavly/profiles/<profile-id>/profile.json   { "id": "<profile-id>", "name": "Work" }
~/.sheavly/profiles/<profile-id>/models/<model-id>.json
    { "id": "<model-id>", "name": "GPT", "adapter": "openai", "model": "gpt-6.1-sol" }
~/.sheavly/profiles/<profile-id>/credentials.json   { "<model-id>": { "apiKey": "sk-..." } }
```

The model file holds everything but the key: its `adapter` (`openai`, `azure-openai` or
`azure-anthropic`) and that adapter's own fields (`GET /adapters` lists them; for `azure-openai` they
are `baseUrl` and `deployment`). The key goes only in `credentials.json`, which must be readable by
you alone (`chmod 600`); the backend refuses to read it otherwise, and never puts a key in an error.

Without a profile the backend still starts, and a conversation is refused with `not_set_up` and a
message saying what to do.

Settings that are about how a process runs (`WORKSPACE_ROOT`) stay environment variables;
`.env.example` lists them. What commands the agent may run is not one: the user decides that per
folder, and it is kept with their profiles.

## 3. Run the tests (free, no network)

```bash
npm test            # run once
npm run test:watch  # re-run on save
npm run typecheck   # type errors only
npm run lint        # ESLint (see "Code quality" below)
npm run format      # Prettier: format everything
npm run check       # the full quality gate: typecheck + build + lint + format check + knip + jscpd + layout + tests
```

`test`, `typecheck`, `lint` and `check` run through Turborepo, so a rerun reuses every result whose
inputs didn't change (see "Code quality").

The tests use a fake `fetch` and scripted providers, so they never call a real API.

`npm run theme:smoke` prints a local visual preview of the default and colorblind terminal
themes, including tool results, diffs and status text. It makes no model calls.

## 4. First real model call (costs money)

```bash
npm run demo -- "Say hello in five words"
```

It runs on the default profile's models (step 2), and starts on the one you used last. For Azure,
the model file is `{ "id": "<model-id>", "name": "GPT", "adapter": "azure-openai", "baseUrl":
"https://<resource>.cognitiveservices.azure.com/openai", "deployment": "<name>" }` (the endpoint
without `/responses` and without `?api-version=`), and `deployment` must match the deployment name in
the Azure portal. `azure-anthropic` (Claude) is the same with its own fields.

### What it does

This sends one prompt through the adapter registry to your model and streams the reply. A short
prompt costs a fraction of a cent. See `apps/terminal/src/demo.ts`.

A conversation with no usable profile is refused with `not_set_up`, and what to do. A
`Responses API error 401` (or `Anthropic Messages API error 401`) means the key is wrong.

For stored prompts, saved runs and stepping through what happened, use the workbook
(`npm run workbook -- list`, see [the workbook doc](apps/terminal/docs/workbook.md)).

Demo settings, as environment variables (see the top of `apps/terminal/src/demo.ts`):

- `WORKSPACE_ROOT=<dir>`: where the file tools, AGENTS.md and `.sheavly/` hooks are read from.
- `SHOW_MODEL_CALLS=true`: prints every model call (main session and sub-agents) with its tools,
  system prompt and latest user message.
- `SESSIONS_SSE_LOG=<file>`: writes the session server-sent event stream (what a UI would read)
  to a file.
- `SHEAVLY_HOME=<dir>`: your folder (default `~/.sheavly`); trusted workspaces are remembered in
  `trusted-workspaces.json` there. The `--trust` flag trusts the workspace's `.sheavly/` hooks:
  `npm run demo -- --trust "your prompt"`.

## Using other backends

A profile holds as many models as you like, on any of the adapters (OpenAI, Azure OpenAI, Azure
Anthropic), each with its own key, and the chat's `/model` switches between them
([models and keys](apps/backend/docs/harness.md#models-and-keys)). Creating providers in code,
switching between them and adding a backend are in [@sheavly/providers](packages/providers/README.md).

## Project hooks (`.sheavly/`)

A project customizes a run with hooks in `.sheavly/` (`hooks.json` and the hook files), loaded only
in a workspace you trust: run the demo once with `--trust`. Writing them, loading them and the
trust model are in [@sheavly/coding](extensions/coding/docs/project-hooks.md).

## Project layout

The harness is npm workspaces: libraries in `packages/`, front ends in `apps/`. Each one's
README is the first place to look, and its `docs/` goes deeper; [docs/README.md](docs/README.md)
lists them all, and [the graph](docs/overview.md#layers) shows what each may import.

Every workspace holds one folder per module, and every file is `<name>.<kind>.ts`. Packages are
imported by subpath (`import { defineTool } from '@sheavly/core/tool/tool.utils'`), and only the
file kinds a package's `exports` makes public (`"./*.types"`), its public API.

## Code quality

`npm run check` is the quality gate: typecheck, the build, ESLint, `prettier --check`, knip, jscpd,
the layout check and the tests. The `Check` workflow (`.github/workflows/check.yml`) runs it on
every PR. The build is in the gate because typecheck compiles with `tsconfig.json` and the build
with `tsconfig.build.json`, which leaves out tests and fakes: a change can pass the first and break
the second.

The shell-write recorder distinguishes concurrent literal `npx prettier --write` operations
using predicted formatting and verified file hashes, not timing alone. A matching formatter
write is attributed to that sanctioned command; arbitrary or unrelated writes still fail the
guard. Prediction does not execute project configuration scripts or plugins. Older records
without hash evidence are never automatically dismissed.

Shell-write findings record the snapshotted checkout root, separately from the command's working
directory. The stop hook checks findings only in that checkout, so moving a chat between worktrees
does not carry another checkout's failures into the new one. Older findings without a recorded
checkout root remain fail-closed; the command's working directory is never used to guess one.

### The pipeline (Turborepo)

`npm run check` runs every task in `turbo.json`, along the dependency graph npm workspaces define:

- **Per workspace:** every package has its own `typecheck`, `lint` and `test` scripts, which check
  only its files, and every one with a `tsconfig.build.json` a `build` script (`tsc -b`; the layout
  check requires it). Each runs after the same task in the packages it imports (`^typecheck`, …).
- **The root** (`//#` tasks): `lint:root` and `test:root` check `scripts/`, `.cursor/hooks/` and the root configs; `format:check`, `knip`, `jscpd` and `layout` check the
  whole repo. `lint:prompt` independently checks the base prompt's tool-contract review record.
- **Cache:** results other than `lint:prompt` are cached in `.turbo/cache` (per checkout, so
  worktrees never share one) by their inputs. A second `npm run check` reuses unchanged results,
  but always rechecks prompt review. A change in
  `turbo.json`, `tsconfig.base.json`, `.prettierrc.json`, `vitest.config.ts`,
  `packages/eslint-config` or the lockfile invalidates every result.
- **Affected only:** `npm run check:affected` runs the workspace tasks only for workspaces changed
  since `main` (committed or not) and those that depend on them, then the repo-wide checks in full.
  CI runs it on PRs and restores `.turbo/cache` from `main`'s last run; the stop hook runs the
  affected typecheck and lint (not the build, which stays in `npm run check` and CI so the hook is
  quick), plus independent prompt review for tool, prompt, metadata and review-tooling changes.
  Prompt failures remain visible even when only a tool is in scope.

### System prompt review

Authored model instructions, tool/parameter guidance and templates live in adjacent `*.prompt.ts`
files. They hold related text/data and pure typed renderers; execution, schemas and runtime data
stay in their existing kinds. Prompt files remain internal by default. `harness/prompt-location`
checks supported model-facing boundaries rather than guessing whether arbitrary prose is a prompt.

`npm run lint:prompt` checks the review record beside `BASE_AGENT_INSTRUCTIONS` in
`packages/host/src/instructions/instructions.prompt.ts`. Production prompt/tool files and their sibling
constants are discovered across workspaces; changes require a new review decision
and explanation. The base prompt is hashed separately, excluding its review comment. A tool-only
change can leave it unchanged when the revised mechanics belong in the tool's prompt description.

This is an offline drift signal, not proof of semantic freshness or model compliance. It does
not fetch Cursor's prompt or force tool descriptions into system instructions. Full and affected
quality gates always run it without a cache. The review record is not a suppression baseline:
missing, malformed and stale records fail. See [prompt review](packages/eslint-config/docs/rules.md#system-prompt-review).

```bash
npx turbo run test --filter=@sheavly/providers   # one workspace's task (and what it imports)
npm run test -w @sheavly/providers               # the same, without turbo
npm run check -- --force                         # bypass the cache: rerun everything
npx turbo run lint --dry                         # what would run, and what is cached
```

The harness is a backend: `harness/no-terminal-io` (in `@sheavly/eslint-config`, so every
workspace gets it) fails `node:readline`, `node:tty` and `process.stdin/stdout/stderr` in
every package. Only an app (`apps/*`) may use them, print or read env: `baseConfig` reads that from
where the workspace is, so a package can't opt in. A new UI is a new app, made only when its issue
asks for one.

### Workspace layout (`npm run layout`)

A new workspace comes from the scaffold, never by hand:

```bash
npm run new -- package <name> --domain <generic|coding|tooling> --description "…" [--depends-on core,protocol]
npm run new -- app <name> --domain <generic|coding|tooling> --description "…" [--depends-on …]
```

The layout check holds every workspace to the graph, its configs, its public API and its README
and docs/; what it checks is in [@sheavly/eslint-config](packages/eslint-config/docs/layout.md).
Nothing imports an app except the launcher, `apps/sheavly` (`sheavly.launcher: true`), the
product's command line; see [the launcher](packages/eslint-config/docs/layout.md#the-launcher).

### Dead code and duplication (knip, jscpd)

knip (unused files, exports, types, dependencies) and jscpd (copied code) fail on any finding;
there is no baseline. See [the layout doc](packages/eslint-config/docs/layout.md#dead-code-and-duplication-knip-jscpd).

### Prettier

`.prettierrc.json`: 100 columns, single quotes, semicolons, trailing commas, 2-space indent, LF
line endings. Prettier owns formatting; `eslint-config-prettier` turns off every ESLint rule that
would disagree with it. `npm run lint:fix` runs ESLint's fixes first and Prettier after, since a
fix (like adding braces) can need formatting.

### File structure (custom rules)

File kinds, their policies and every `harness/*` rule are in
[@sheavly/eslint-config](packages/eslint-config/docs/rules.md).

### ESLint

Strict and type-aware (typescript-eslint `strictTypeChecked`), with readability rules; no
`eslint-disable` comments and no baseline. See [the rules](packages/eslint-config/docs/rules.md#the-rest-of-the-config).

### Cursor hooks

`.cursor/hooks.json` runs the same checks automatically while the Cursor agent works.

Prompt and shell guards use Node built-ins so a fresh worktree can accept messages and run
dependency installation. The hooks' shared clock uses epoch milliseconds anchored to each short-lived
process's start. Lint hints are loaded only by the edit hook; formatter prediction loads Prettier
only when a command needs it. Formatting, linting and every stop quality check remain enabled.

Before moving a session into a separate worktree, run from the initialized checkout:

```bash
node scripts/bootstrap-worktree.mjs /path/to/worktree
```

It is a manual step: no hook or npm script runs `bootstrap-worktree.mjs` or `verify-worktree.mjs`,
and the `/git` skill's start procedure calls it. It installs with `npm ci`, probes the configured
fail-closed guards with isolated temporary chat state, and checks the quality-tool executables.
Move the session only after successful verification; on failure stay in the original checkout.
Missing tools are setup failures, not skipped checks.

| Event                           | Script                                 | What it does                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| ------------------------------- | -------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `beforeSubmitPrompt`            | `.cursor/hooks/require-issue.mjs`      | A chat's first prompt must name its GitHub issue (`#123`, or check out its branch); `NO-ISSUE` opts out, Ask mode is exempt. Remembers the issues named (several for a stack), and "allow cherry-pick", per chat. See "Git workflow".                                                                                                                                                                                                                                                                                                                      |
| `beforeShellExecution`          | `.cursor/hooks/guard-git-workflow.mjs` | Denies agent git/gh commands that break the git workflow: a branch not `<issue>-<name>` for one of the chat's issues, `git add -A`/`.`, `--force`, a non-squash merge, an unapproved cherry-pick, a commit message off the format, `gh issue create` without an `area/*` label, interactive `gh stack` forms.                                                                                                                                                                                                                                              |
| `postToolUse` (matcher `Write`) | `.cursor/hooks/lint-edited-file.mjs`   | Formats the file the agent just edited with Prettier, then lints it, and returns notes and problems as `additional_context`, so they're fixed right away. The first edit of harness source in a chat also injects the skill's "Where code goes", and the first edit inside a workspace shows its README. The first edit of a file a skill governs (its `harness.json` `governs` globs) names that skill, once per chat. TypeScript written outside every workspace's `src/` is reported on the edit (`layout.utils.mjs`). Advisory: never blocks the edit. |
| `stop` (`loop_limit: 3`)        | `.cursor/hooks/check-on-stop.mjs`      | When a turn finishes (`status: "completed"`), runs typecheck + ESLint for the affected workspaces (turbo, cached), independently checks prompt review for tool/prompt/metadata/tooling changes (uncached), then Prettier check + knip + the layout check + jscpd (any clone fails: there is no baseline) on the whole repo. On failure it returns a `followup_message` with the report, so the agent keeps fixing, at most 3 extra rounds.                                                                                                                 |

Shared helpers (stdin/stdout JSON, edited-path lookup, running local binaries) are in
`.cursor/hooks/hooks.utils.mjs`. Cursor reloads `hooks.json` on save; check the **Hooks**
output channel if a hook doesn't fire. To try one by hand:

```bash
echo '{"tool_input":{"file_path":"packages/core/src/tool/tool.utils.ts"}}' | node .cursor/hooks/lint-edited-file.mjs
echo '{"status":"completed"}' | node .cursor/hooks/check-on-stop.mjs
```

Both print `{}` when everything passes.

## Git workflow

GitHub is the only tracker: work is a GitHub issue in this repo, and nothing uses Jira or any other
tool. All git and GitHub work goes through the `/git` skill (`.agents/skills/git/`), for people as
well as agents; its `conventions.md` has the formats with good and bad examples.

- **One issue, one branch, one PR**, based on `main`. Work too big for one PR is split into
  sub-issues with their own PRs, or, when the parts depend on each other, into a **stack of PRs**:
  each layer is a normal issue branch and PR based on the layer below, the bottom one on `main`
  (`.agents/skills/git/stacks.md`; `gh stack` optional). Lower layers end with `Part of #123`
  instead of `Closes #123`, so the issue closes when the top layer merges.
- **Branches:** `<issue>-<kebab-name>` (`123-provider-switch`), GitHub's own form:
  `gh issue develop 123 --name 123-provider-switch --base main --checkout` links it to the issue.
- **Commits:** one scope each, in the order the work was built, so a reviewer reads the PR commit
  by commit. `type(scope): subject` (types `feat fix refactor perf test docs build ci chore
revert`; the scope is a package or `src/` folder, or left out for root tooling; imperative,
  lowercase, no full stop, header at most 72 characters), an optional body explaining why, and a
  `Refs: #123` footer.
- **PRs:** opened as drafts. Title `type(scope): subject`, with no issue number; it becomes the
  squashed commit on `main`. The body (`.github/pull_request_template.md`) has Why, Commits, What
  changes, How to review and Test plan, and ends with `Closes #123`, which links the PR to the
  issue and closes the issue on merge.
- **Issues** have a type (`Task`, `Bug`, `Feature`, set by the forms in `.github/ISSUE_TEMPLATE/`),
  are split into sub-issues when they're bigger than one PR, and record order as "blocked by"
  dependencies. Every issue has at least one **area label**, one per commit scope its PR will have
  (`area/core`, `area/loop`, …, `area/tooling` for work without a scope), plus `security` where it
  applies. The area labels come from the same folders as the commit scopes and are created by the
  `Sync labels` workflow (`scripts/sync-area-labels.mjs`) on every push to `main`. Labels only for
  what types can't say, never for status or priority (`.agents/skills/git/issues.md`).
- **Status** is read from GitHub: open, blocked, a branch or draft PR (in progress), a ready PR (in
  review), closed by the merge (done). A GitHub Project board, if used, mirrors that.
- **Rewriting:** while the PR is a draft, fixes are folded into the commit they belong to and
  pushed with `--force-with-lease`; once it's ready for review, fixes are new commits on top.
- **Merging:** `gh pr merge <n> --squash` (`gh stack merge <pr> --yes --squash` for a stack).
  Every push of new work is first reviewed by Bugbot and a security review.
- **Development-harness impact:** the ESLint and git/GitHub guardrails around the codebase,
  not the product runtime. The git skill assesses constraints at triage and in a closing pass
  before submission (`.agents/skills/git/harness.md`). Missing enforcement and regression tests
  ship in a distinct closing commit when dependencies allow. Reviewers verify coverage, not just
  type ownership or layout; every PR reports evidence or a specific reason no change is needed.
- **Enforced:** the issue gate and the git guard (hooks above) for agents; the `Git format`
  workflow (`.github/workflows/git-format.yml`, running `scripts/check-git-format.mjs`) for every
  PR's title, branch, base (`main` or an issue branch, for stacks), `Closes #`/`Part of #` line,
  an area label on its issue for every commit scope, and the `## Harness impact` reporting format
  (enforcement and regression-test references, or a reason no guardrail is needed). This check
  does not prove the cited guardrail covers the constraint. The `Issue labels` workflow
  (`scripts/check-issue-areas.mjs`) fails, and comments once, on an open issue without an area
  label. Dependabot's PRs are the one kind without an issue.
- **Repo settings** (once, by a person; `.agents/skills/git/setup.md`): squash merging only,
  defaulting to the PR title; branch protection on `main` requiring the `Git format` and `Check`
  checks.

## License

Licensed under the [Apache License, Version 2.0](LICENSE).

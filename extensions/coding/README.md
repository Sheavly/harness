# @sheavly/coding

Coding as an extension (see [the extensions guide](../../.agents/skills/sheavly/extensions.md)):
the coding tools and the hooks that go with them. `createCodingExtension` opens the workspace and
makes one file-reads store and one process runner (`@sheavly/process`) for its tools, and
contributes the file tools, `read_skill`, `run_command`, `start_service`, the AGENTS.md, skills,
scratch and working-root hooks and the workspace's `.sheavly/` hooks. It shares them with
sub-agents through `@sheavly/agents`. Its `sheavly.json` declares those tools and hooks, the
services it requires (`sub-agents`, `session-info`, `background-tasks`, `approvals`,
`main-session`), `output-capture` it may read and `coding-run` it provides, and the grants it
holds: `output:capture`, `session:read`, `task:start`, `approval:request`, `approval:as-tool`,
`approval:keep`, `system-prompt:extend` and `sub-agent:share` (to share its tools and hooks with
sub-agents). It also contributes one system-prompt section, named
`coding` in the manifest's `instructions`: the coding guidance, with its own `# Coding work`
heading.
The user chooses the names of a workspace's own `.sheavly/` hooks, so the manifest declares hooks
with the bare wildcard `*` (the `@sheavly/extension` manifest doc explains wildcards). A coding UI composes it in an
`ExtensionHost` (`@sheavly/extension`) with the other extensions it wants, over the run services
(`runServices` from `@sheavly/host/run-services/run-services.helper`).

```ts
import { createCodingExtension } from '@sheavly/coding/extension/coding-extension.helper';

// The app passes only its own `instructions`: the coding guidance comes from the extension.
const harness = createHarness({ provider, title, instructions });
const coding = createCodingExtension({
  workspaceRoot,
  env: process.env,
  permissions,
  trustStore,
  shell,
});
```

The extension integrates like a third party, with no access one lacks (`origin` only gates
loading). It reads the run services under its declared grants, with the keys and types imported
from `@sheavly/extension/run-services/run-services.utils` and `.types`: `SESSION_INFO` (the main session's
idle keeps its file reads, a released session's reads are forgotten), `BACKGROUND_TASKS` (the
tasks `run_command` and `start_service` start, owned by its scope), `APPROVALS` (the approval
prompt; `approval:as-tool` lets it ask as `run_command` or `start_service`, and `approval:keep`
lets it offer "Allow for this session" and "Always allow"), `MAIN_SESSION`, `SUB_AGENTS` and,
when supplied, `OUTPUT_CAPTURE`. Its options are the app's choices: `workspaceRoot`,
`scratchRoot`, `env` (for the workspace, the working root and home resolution and the commands'
environment; the run services carry no environment), `fileLocks` (one set shared by every run of
an app, so two runs editing one file take turns; default: its own), `permissions`, `home`,
`trustStore`, `trustWorkspace`, `shell` and `onFileReadsProblem`. Grants limit what a service
does for an extension; they are not a sandbox.

Pass `scratchRoot` (an absolute folder the app picks, e.g. `<tmpdir>/sheavly`) to let the file
tools also use a shared scratch folder outside the repo; see
[file tools](docs/file-tools.md) and `@sheavly/workspace`.

| Module              | What it holds                                                                                     |
| ------------------- | ------------------------------------------------------------------------------------------------- |
| `extension/`        | `createCodingExtension`, `CODING_RUN`, `CODING_HOOK_NAMES`: coding as an extension of a run       |
| `file-reads/`       | `keepReadsWithConversation`: restores and keeps what the main agent read with its conversation    |
| `instructions/`     | `CODING_INSTRUCTIONS`: the coding guidance the extension contributes as a prompt section          |
| `read-file/`        | `read_file`, and the `FileRead` artifact with its `isFileRead` guard                              |
| `grep/`             | `grep`: ripgrep search of the workspace, and the `GrepResult` artifact with its guard             |
| `glob/`             | `glob`: files matching a pattern, newest first, and the `GlobResult` artifact with its guard      |
| `read-skill/`       | `read_skill`: a skill's SKILL.md or a file in its folder, from the project's or the user's        |
| `write-file/`       | `write_file`                                                                                      |
| `edit-file/`        | `edit_file`                                                                                       |
| `delete-file/`      | `delete_file`: removes one file, through the workspace and the file lock                          |
| `run-command/`      | `run_command`: base-command permissions, safe git config, approvals                               |
| `trail/`            | `fileTrail`: one short line per file-tool or `run_command` call, for a summary's trail            |
| `working-root/`     | `set_working_root` and the hook that tells the agent its root each turn                           |
| `files/`            | What the file tools share: `resolveWritable` / `resolveDeletable`, the `.env` guard, `FileChange` |
| `trust/`            | `TrustStore`: which workspaces the user trusts to run their `.sheavly/` hooks, outside every repo |
| `project-hooks/`    | `loadProjectHooks`: the `.sheavly/` hooks, only in a trusted workspace                            |
| `project-settings/` | `readProjectSettings`: a project's `.sheavly/settings.json` text under confinement and a size cap |
| `agents-md/`        | `agentsMdSource`: AGENTS.md files as append-only instruction context                              |
| `skills/`           | `findSkills`, `skillsSource`, `skillRequest`; mentions and completion for UIs                     |
| `errors/`           | `CommandRefusedError`, and the trust, project-hook, AGENTS.md and skill errors                    |
| `testing/`          | Fakes for tests: `memoryTrust`, `useSkillFolders`, `fakeBeforeTurn`                               |

## Built-in hook names

The instruction hooks are named `agents-md`, `skills`, `scratch` and `working-root`, in that
order among the ones present (`scratch` is only registered when the workspace has a scratch
root). The names are a stable contract: a third-party extension positions its hooks against them
with `placeHook({ hook, before: [CODING_HOOK_NAMES.agentsMd] })`, so renaming one is a breaking
change. Import `CODING_HOOK_NAMES` from `@sheavly/coding/extension/coding-hook-names.constants`.
The `.sheavly/` project hooks come after them, under their own names. The `scratch` literal lives
in `@sheavly/workspace`, which cannot import an extension;
`src/extension/__tests__/coding-hook-names.test.ts` pins all four against the hooks the extension
builds. `sheavly.json` lists the same four names next to a bare `*` for the project hooks, so the
host would not notice a fifth name added to the constant but not to the file; the test in
`src/extension/__tests__/coding-extension.helper.test.ts` compares the two.

## Docs

`run_command` starts required finite work with `background: true`: the loop keeps the prompt alive
until its result is delivered. Persistent servers and watchers use the `start_service` tool
instead, which has the same checks and approval. The agent can finish independent work, then yield without polling task status: the result is
delivered automatically and wakes it. The optional generic `await_tasks({ ids, reason })` tool
only groups two or more results for delivery together, never one; its reason preserves the
dependent decision or next step for the agent after a summary.

With an output store (the conversation's `OutputStore`, supplied to the run as `OUTPUT_CAPTURE` for
writing and `OUTPUT_READER` for `read_output`), `run_command` keeps every command's complete
captured stdout and stderr, foreground or background, independent of the bounded preview. Output
printed before a failure, timeout or cancellation stays readable, and a running service's log can be
read as it grows. The result carries `output_ref=<id>`, the bytes stored and whether the log is
`complete`, `capturing` or `INCOMPLETE`. When the preview is shorter than the log, the result also
tells the model to use `read_output` or `search_output` instead of rerunning the command. Pipeline
stdin gets the original bytes; stdout routed into a pipe is not duplicated in the log, only what the
last stage and every stderr print. If storage cannot start a capture the command still runs and the
result says the full output is not being stored; a storage failure mid-capture marks the log
incomplete, never complete. Without it only the preview exists, as before.

The coding guidance is a section the extension contributes (`instructions: [{ name: 'coding',
text: CODING_INSTRUCTIONS }]`, under the `system-prompt:extend` grant), not something an app
composes. The run's system prompt is the generic core, then the sections of the extensions in
activation order (coding's among them), then the app's own `instructions`. The app's
`baseInstructions` replaces only the generic core, not coding guidance. An app that wants `coding`
without its guidance lists the section `coding` in `omitInstructionSections`. The option controls
only the declared instruction sections. An extension's tools, hooks, notices and any section whose
name the app does not know are not covered, and an extension can still infer an omitted section
from the composed text: to remove an extension's influence, leave the extension out. Conversations use this
text by default; direct loop callers pass it explicitly. See
[instruction composition](../../packages/host/docs/harness.md#instruction-composition).
Coding guidance excludes routine investigation of secret-bearing files and forbids probing or
bypassing protected-file rules. Tool guards still enforce those rules independently.
The coding section is a short reminder to inspect first, fit the surrounding code, preserve
existing work and verify changed behavior; detailed procedures stay in tools and project instructions.
Its source is the internal `src/instructions/coding-instructions.prompt.ts`. Each tool's adjacent
`*.prompt.ts` owns its model-facing description and input guidance, plus instructional output notes.
These prompt modules are internal; schema validation, runtime effects and UI artifacts stay in code.
The public `CODING_INSTRUCTIONS` constant remains at its existing constants subpath as a direct,
typed alias, preserving both its value and literal type without duplicating the authored text.

- [File tools](docs/file-tools.md): confinement, the four tools, the artifacts they return, and
  the [working root](docs/file-tools.md#the-working-root) an agent can set for a worktree.
- [Skills](docs/skills.md): the skill format, where skills are found, and which one wins;
  `read_skill` returns complete skill files without line or character caps, while preserving path
  confinement and `.env` protection. Ordinary `read_file` limits are unchanged.
- [AGENTS.md](docs/agents-md.md): which files the hook reads, and when.
- [Project hooks](docs/project-hooks.md): writing `.sheavly/` hooks, loading them, and workspace
  trust.
- [run_command](docs/run-command.md): how a command is checked before it runs.

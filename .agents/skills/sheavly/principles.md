# Principles

What lint enforces is stated as such; the rest is judgement a reviewer holds you to.

## Structure: extend, don't modify

1. **Find the system before adding a mechanism.** Every concept has one owner (background work, status, notices, hooks, instruction context, approvals, storage). If your change needs a second copy of a mechanism, the first is missing an extension point: add the point, not the copy. Sharing a dependency does not make two callers obey the same contract.
2. **A behaviour is decided once, in the system that owns it.** A caller does not pick a completion policy, a notice shape or a cleanup path. It names a kind and the system decides.
3. **A core module is not edited to special-case one caller.** If the loop's turn, the hook runner or a registry needs an `if` for your feature, add an extension point and use it.
4. **Restructuring never changes behaviour; a behaviour change is its own change.** Say which it is in the PR. A behaviour change updates the guide that states it and the test that pins it.
5. **Name an implicit state machine when you find one.** State held in booleans, optional fields, map membership or "what history says" is a state machine. Give it one table of states and transitions in one module and make every reader use it ([state-machines.md](state-machines.md)). Two enums for the same fact is a bug waiting to happen.
6. **Contributions add, they never own.** Hooks add to the loop; a tool, adapter or extension never takes the loop over. Names are unique and a collision fails loudly.

## Code (lint enforces the mechanics; see [quality-gate.md](quality-gate.md))

- A function is a few steps. When one does several jobs (setting up, streaming, cleaning up), extract each into a function named for what it does; don't just reshuffle conditions to get under a limit.
- Extract a function when its name hides something the caller no longer needs to know. If reading the caller means opening the helper, the split went too far: keep it inline.
- Remove duplication of knowledge, not of shape. Two blocks that look alike but change for different reasons stay separate. A shared function that grows flags or special cases for one caller is the wrong abstraction: inline it back and extract only what is truly common.
- Parse once at the boundary into a precise type, and let code past it trust that type: no re-checks downstream, no optional fields for states that can't coexist (use a union). All external input is validated with zod (tool inputs, adapter config, env).
- A function that changes state outside itself says so in its name (`keepHistory`, not `record`).
- Name a value when the name adds meaning the expression lacks; otherwise return or pass it directly. Branch with early `return`, not chained ternaries.
- Code that looks wrong on purpose (a hand-driven iterator instead of `for await`, an order that matters) gets a comment saying why. Comments are one or two sentences of constraint or trade-off, never what the code does; history goes in the commit message.
- An exported function or type gets a doc comment for what its signature can't say: what it expects, what it throws, what order or state it relies on.
- Interrupts leave history valid: every tool call gets a result message, even a placeholder.

## Errors, time and secrets

- Fail loudly. A `catch` rethrows, or checks the error (`code`, `instanceof`) and handles only what it expects, with a comment saying why; a rethrow with a better message keeps `cause` (`harness/no-silent-catch`). Guards fail closed and say why.
- Source never creates a plain `Error`: throw a typed class from the area's errors (each workspace's `src/errors/`, `.cursor/hooks/hooks.errors.mjs`), adding one if none fits (`harness/no-raw-error`; tests, fakes and `scripts/` are exempt).
- Time is epoch milliseconds (`timestampSchema`, `@sheavly/protocol/time/time.validator`), read with `now()` (`@sheavly/core/clock/clock.helper`, through Luxon) and formatted for a person only at the edge. Never `Date`, never an ISO string (`harness/no-direct-clock`); a test fixes the clock with `useFixedClock` (`@sheavly/testing/clock/fixed-clock.fake`).
- Never read or write `.env*` files; credentials stay inside the credential store.

## Files, paths, secrets and history

Each of these has one owner; code that does it another way fails lint (the rule is named).

- **Writing files.** The user's data (conversations, models, trust, config) is written through `@sheavly/storage`, which writes atomically and privately; the agent's file tools write a project through `Workspace`. No other code imports the `fs` mutators (`harness/no-direct-file-writes`); import what you read by name.
- **Changing a file whole.** A store that reads a file and writes it back changes it through `LockedChange` (`@sheavly/storage`'s `serial-queue/`): a queue in the process and a lock file across processes. `harness/no-raw-serial-queue` fails `new SerialQueue()` in source files; the primitive, the append-only `AppendLog` and the profile registry's queue are the pinned exceptions. Review-only: a queue passed in from elsewhere, or a lock written by hand.
- **Credentials.** Keys are read and written only through `CredentialStore`, and only the backend app imports it or the profile registry (`harness/no-credentials-file`, `harness/no-key-holder-import`). Any other code is given the secret it needs as an option. Never name `credentials.json`.
- **The server's discovery file and lock.** Where a running server publishes its address and token and holds its one-server lock is resolved in one place: `serverRuntimeDirectory` (`@sheavly/storage`'s `server-runtime/`) reads the runtime-directory variable and checks the folder, `discovery-file/` writes and reads the file (only there), and its name is `DISCOVERY_FILE_NAME` in `@sheavly/protocol`. `harness/no-discovery-path` fails a source file elsewhere that names the variable or the file, and a name split across pieces or held in a variable is review-only. Every workspace but the server (the backend) finds the running server only through `findRunningServer` with `verifyServer`, so the token is used only after the handshake: `harness/server-through-finder` fails its source importing `discovery-file/`, `server-lock/` or `server-runtime/` directly, and a call of the finder without `verify: verifyServer` written in it; `createRequire` and a computed start of a specifier are review-only.
- **The file tools' guards.** Reading, writing and searching a project goes through the guarded resolvers: `harness/guard-env-read`, `harness/guard-env-write`, `harness/guard-search-root` and `harness/guard-working-root` fail a tool that skips them, and `harness/guard-file-tool-resolve` fails a `*.tool.ts` that calls the workspace's `resolveRead`/`resolveWrite`/`resolveDelete` itself instead of `resolveReadable`/`resolveWritable`/`resolveDeletable` (`files/files.helper.ts`). The policy table (what each tool does with `.env`, `.git`, symlinks, reads, locks, size and abort) is in `extensions/coding/docs/file-tools.md`; add a tool by adding its row to `file-tool-policy.test.ts`. The permission store is keyed by the main worktree's folder, so every call passes `permissionRoot(...)` written in the call (`harness/permission-store-root`).
- **Paths.** Test whether a path is inside a folder with `isInside` (`@sheavly/workspace/workspace/workspace.utils`), never `startsWith('..')` (`harness/no-dotdot-prefix`).
- **Env.** Only an app reads `process.env` and passes it in (`harness/no-process-env`).
- **The latest request.** What counts as the request in stored history is decided once, in the history helpers of `@sheavly/core` (`latestRequest`, `latestRequestIndex`, `latestPromptIndex`): a stored `user` entry, never a notice (`harness/no-adhoc-latest-request`). Code that works on what a model is sent is a model view and says so in a `files:` override.
- **Ids.** An id in a schema is branded (`z.string().brand<'<X>Id'>()`), so a session's id can't be passed where a tool call's goes (`harness/branded-ids`). A branded value is made by parsing with its schema, never asserted with `as` (`harness/no-brand-cast`).
- **Prompts.** Authored model text lives in `*.prompt.ts`, and a change to a production prompt needs an explained review (`harness/system-prompt-review`, `npm run lint:prompt`; see [file-kinds.md](file-kinds.md)).

## Enforce what you add

When you introduce a package, a convention or a pattern the harness doesn't check yet, add the check in the same change (a `harness/*` rule in `packages/eslint-config/src/rules/`, a `file-kinds.js` policy, a layout check, a test), never a gap or a doc-only note.

- Derive it from the code (workspaces, file names, exports) rather than a hand-kept list, so it grows by itself.
- Make its message say what to do instead.
- Map the rule to the guide that explains it in this skill's `harness.json` (`lintRules`, `ruleFiles`), so the violation carries the pointer.
- `harness/single-definition` is the model: every `*.types.ts` in the workspaces owns the types it exports, read from disk, so a copy anywhere fails with where the original lives; exemptions go by file role (tests, fakes), never by name.
- Say plainly what a check cannot decide. No generic rule can tell whether an abstraction is clean or detect every divergence; behavioural contract tests cover what static lint cannot.

## What lint enforces here, and what it cannot

| Convention                                               | Enforced by                                                                                                                      | Review-only part                           |
| -------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------ |
| Imports point down the layers; app-only modules          | `harness/imports`, `harness/layout`                                                                                              | whether a piece is in the right package    |
| File names, kinds, contents, length                      | `harness/file-kind`, `harness/kind-contents`                                                                                     | whether a file does one job                |
| One definition per type                                  | `harness/single-definition`                                                                                                      | a type that only looks alike               |
| No terminal I/O, env, clock, raw errors, silent catches  | `harness/no-terminal-io`, `harness/no-process-env`, `harness/no-direct-clock`, `harness/no-raw-error`, `harness/no-silent-catch` | whether the error is the right class       |
| Notice envelope written only by the formatter            | `harness/no-handwritten-notice`                                                                                                  | a tag built from a variable                |
| Prompts live in `*.prompt.ts`                            | `harness/prompt-location`                                                                                                        | dynamic paths static analysis can't follow |
| Readability limits (depth, complexity, nesting)          | the readability rules in `base.js`                                                                                               | whether the code reads well                |
| Background work enters the registry through a factory    | `harness/no-direct-task-start`                                                                                                   | `any`, a structural type; session scoping  |
| Two mechanisms for one concept, behaviour of a lifecycle | nothing else yet (contract tests where they exist)                                                                               | all of it: use the owning system           |

The last row is the gap this skill exists to close: a lifecycle or a policy is held by tests that run every kind through the same assertions, and by reading the owning guide before adding a path.

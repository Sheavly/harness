# Scoped run services

`runServices({ harness, outputs, runSession })` (`run-services/run-services.helper.ts`) returns the
services every extension of a run can read without a `dependsOn`. The keys are defined in
`@sheavly/extension/run-services/run-services.utils`, not here: the host implements them, and a
test pins that it supplies every key the extension package defines under its exact name. Most are built **per extension** by a factory
(`hostServiceFor`, `@sheavly/extension`): the host calls it once, the first time an extension that
declared the service reads it, with the extension's name and sealed manifest. Each method of the
value it returns checks a **grant**, a `<noun>:<verb>` string in the extension's `sheavly.json`
`grants` list, and throws an `ExtensionUndeclaredError` naming the extension and the grant when it
is missing. The host reads `manifest.grants` once, when the service is built.

The types the services carry (the scope views, `ApprovalRequester`, `SystemPromptView`) are stated
in `@sheavly/extension/run-services/run-services.types`; the classes that implement them are the
`*.service.ts` files of `run-services/`. `ScopeDeactivatedError` is defined in
`@sheavly/extension/errors/scopes.errors`. The scope errors that stay in the host
(`errors/scopes.errors.ts`) are `ScopeArgumentError`, `ApprovalToolNotContributedError` and
`ChildRunningError`. `RunLoop`, the loop's runner type, is host-only.

**A grant limits what a service does for an extension; it is not a sandbox.** An extension is Node
code. It can use `fs`, `child_process` and `fetch` without declaring them, and a grant is only as
strong as the service behind it. Nothing reads `origin`: a built-in extension gets exactly what its
manifest declares, like a third-party one.

## The services

| Key (`run-services.utils`) | Name               | Grant (checked by)                                                                                                                                                        | What it leaves out                                                                                                                                  |
| -------------------------- | ------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| `SESSION_INFO`             | `session-info`     | `session:read`: `get`, `list`, `isReleased`, `releasedStarts`, `onLifecycle`                                                                                              | message content, inboxes, every write, the registry                                                                                                 |
| `CHILD_SESSIONS`           | `child-sessions`   | `sub-agent:create`: `startChild`, `setModel`, `runChild`; `sub-agent:message`: `send`; `sub-agent:observe`: `onUpdate`; `sub-agent:report`: `report`                      | `publish*`, `end`, `idle`, `resume`, `release*`, `subscribeEntries`, `stream`, notices, inboxes, `'user'` as a sender, any session it did not start |
| `BACKGROUND_TASKS`         | `background-tasks` | `task:start`: `start`; `task:read`: `get`, `report`, `list`, `observe`; `task:cancel`: `cancel`, `group`                                                                  | other extensions' tasks, `cancelAll`, `cancelSession`, deliveries, `release*`                                                                       |
| `TASK_CONTROL`             | `task-control`     | `task:read-any`: `getOwned`, `list`, `report`; `task:cancel-any`: `cancel`, `group`                                                                                       | `start`, `cancelAll`, `cancelSession`, deliveries, `release*`; every call needs a `sessionId`                                                       |
| `OUTPUT_READER`            | `output-reader`    | `output:read`: `log`, `read`, `search`                                                                                                                                    | `create`; absent when the app has no output store                                                                                                   |
| `OUTPUT_CAPTURE`           | `output-capture`   | `output:capture`: `create`                                                                                                                                                | reading; absent when the app has no output store                                                                                                    |
| `MODEL`                    | `model`            | `model:call`: `stream` (`contextWindow` is forwarded live)                                                                                                                | nothing else a provider has                                                                                                                         |
| `APPROVALS`                | `approvals`        | `approval:request`: `request` and the read-only `listening`; `approval:as-tool`: `tool` may name a tool the extension contributes; `approval:keep`: `options` and `keeps` | `respond`, `subscribe`, `observe`, `pending`, `screen`                                                                                              |
| `INSTRUCTIONS`             | `instructions`     | none: a read-only `{ text }` view, composed at each read                                                                                                                  |                                                                                                                                                     |
| `MAIN_SESSION`             | `main-session`     | none: a constant                                                                                                                                                          |                                                                                                                                                     |

An extension may only hold a grant of a service it reads (`services.requires` or `optional`): a
grant of an unread service, or one no service defines (a typo), fails its activation, as does any
other manifest mismatch.

`INSTRUCTIONS.text` is read at use, never cached: the extensions' contributions appear only after
every extension has activated, so during any extension's `activate` it is the base plus the app's
own instructions, and a read made later (such as the agents extension's read when it starts a
sub-agent) sees them.

## How the scopes hold together

- **Ownership.** `CHILD_SESSIONS` and `BACKGROUND_TASKS` remember the ids of what the extension
  started in a private set, so two extensions with the same grants own different things, and an
  id that is not yours behaves as an unknown one (a `SessionError` `unknown_session`, an
  `undefined` task, a `TaskError` `unknown_task` for a group). `TASK_CONTROL` owns nothing: the
  `sessionId` of each call is its scope, because the task tools act on every task of the calling
  session whatever started it. That `sessionId` is required, since the task registry reads an absent
  one as every task of the run. `SESSION_INFO` is not scoped to what you started: history search
  lists every session.
- **Sub-agents.** `startChild` needs a parent that is the main session or a child the extension
  owns. `send` comes from the main session or an owned child; the registry's ancestor rule still
  applies. `onUpdate` delivers an update only when its session is owned at that moment, so the
  update that announces a child's start, sent while it is being started, is not heard. A
  message to a session the extension did not start reads as `Unknown session`, whoever started it.
- **Frozen copies.** The scope keeps its own frozen record of each child and returns a different
  frozen copy, so changing the returned ref (to name another session, say) throws and cannot
  redirect `runChild`, which builds what the loop receives from the scope's record. The
  `main-session` service is a frozen copy of the harness's own object, and the scope objects are
  frozen too. The `SessionInfo` and `TaskInfo` the services return are detached copies of the
  registry's state, so changing one changes nothing in the run; they are not frozen.
- **`runChild`.** It owns the call into the loop. `runServices` is given the loop's `runSession`
  and the scope builds `{ registry, ref: child }`, passes the run's full session and task
  registries to it, keeps the history as `keepHistory` is told, and cancels the child's own tasks
  (`cancelSession`) when the run ends, however it ends. The extension never holds a registry, the
  loop or a `RunSession`. It refuses a child that is not owned, that has ended, or whose run has
  not returned yet (`ChildRunningError`; the flag clears however the run ends). `onRunEnd` is
  called when the loop has returned, before the cancel, so a caller can stop listening first; the
  cancel runs even if `onRunEnd` throws, and when the run and `onRunEnd` both fail, the run's
  error is the one thrown.
- **Tasks.** `start` needs the `sessionId` of an open session of the run (an ended or unknown one is
  refused) and starts through `startWork`. A task is owned by the id its own `start` returned:
  what the registry announces during the call is held until then, so a task another scope starts
  meanwhile is never claimed. Events reach `observe` in the order heard, through a queue: an
  observer that throws never stops `start`, the other observers or the events after it (its error
  is rethrown on its own, as a registry listener's is), and what a nested `start` announces is
  delivered after the events already queued.
- **Skipped extensions.** The scope of a service is built when the host checks that an extension's
  required services are readable, so one is also built for an extension that is then skipped
  (untrusted, dependency, service); the host disarms it then, like any other stop.
- **Approvals.** By default the scope builds the request from `callId`, `sessionId`, `command`,
  `concerns` and `signal` only: `tool` is `extension:<name>`, the `command` the user reads is
  prefixed with `[<name>]`, only the default options are offered (no `always_allow`, no
  `allow_session`) and there is no `keeps`, so an answer applies once and never becomes an allow
  rule. Two more grants widen that, checked only when their field is used; a request that uses a
  field without its grant is refused with `ExtensionUndeclaredError` naming the grant, never
  silently narrowed. `approval:as-tool` lets `tool` name a tool the extension contributes: the
  host records the names it contributed once it has checked them against the manifest after
  `activate` returned, and `tool` must be one of them by exact name (else
  `ApprovalToolNotContributedError`). A request made during `activate`, or after the extension is
  stopped, is refused too. Contributed names are unique across a run (a collision fails the
  run), so no other extension can be attributed as that tool; a name that is only declared in
  the manifest gets nothing. The `command` is then not prefixed. `approval:keep` lets `options`
  (a non-empty subset of the protocol's options) and `keeps` through: `keeps` are allow entries
  parsed with the protocol's schema, at most 20 of at most 500 characters (`ScopeArgumentError`
  otherwise; `keepsFit`, `@sheavly/extension/approval/approval-keeps.utils` (the limits are defined there too), says whether entries fit, so a caller can
  leave them out instead of failing; coding does, and offers only approve, skip and
  skip_with_message when its proposed entries do not fit). `always_allow` and `allow_session` need
  a non-empty `keeps`, and the registry refuses an answer outside `options`. The host passes
  `options` and `keeps` through, bounds them and checks that the answer is one of the offered
  options; whether and how an entry is kept is the requesting extension's own code (coding
  persists the entries through its permissions after the answer). `keeps` are shown to the user
  in the prompt. `concerns` is rebuilt as `{ argument, reason }` strings: a non-array is none, an
  entry without two string fields is dropped (nothing becomes the text `undefined`), and at most 50
  are kept, each string at most 1000 characters, with nothing cut silently: a longer string ends
  with `…` (counted in the cap), and over 50 concerns the first 49 are kept and one last concern
  `{ argument: '+N more', reason: 'not shown here: the request had M concerns' }` says how many are
  not shown; at or under the cap they pass through as given. `command` is not bounded here. The `[<name>]` prefix is a
  label, not an unforgeable attribution: the caller's text follows it and may contain newlines
  (a terminal shows control characters as literals), so a screener should trust `tool`. A
  `sessionId` may be any open session of the run, not only one the extension started.
- **Which grant a method needs.** It is data, `RUN_SERVICE_GRANTS` in
  `@sheavly/extension/run-services/run-service-grants.constants`, not a literal in a scope. A scope
  holds a `ScopeGuard<'<service name>'>` and starts each method with `guard.enter('<method>')`
  (`enter('request', 'tool')` for an argument with a grant of its own); `enter` looks the grant up
  and checks it, after the check that the scope is still armed. A method the table does not declare
  does not compile, and `scopedService` takes the grants a manifest may ask for from the same table.
  A scope that gains a method adds it to the table first:
  `run-service-grants.service.test.ts` fails when a scope's public members and the table differ,
  when a service offers a grant no member needs, and when a method runs without its grant. The
  same table is what `harness/extension-declares-grants` reads to check an extension's calls
  against its manifest before they run (`packages/eslint-config/docs/rules.md`).
- **Switching off.** The host disarms every instance before the extension's own `deactivate` runs,
  wherever it stops the extension's emitter (deactivate, a roll-back, a failed activation). After
  that every method throws a `ScopeDeactivatedError` naming the extension and the service, and
  what the scope had subscribed to is stopped. It does not abort a `runChild` already in flight
  nor cancel the tasks the scope started. A `disarm` that throws is contained and reported
  (a rejected promise it returns is collected best-effort when it settles); the extension host
  returns the errors from `deactivate()`, and from the next call when an activation failed.
- **What the scopes do not hand out.** No scoped service hands out `publish`, `queueNotice` or
  `publishTask`. They are not silent: `send` and `report` produce session updates, and a child's
  loop publishes its events.
- **`output:read`** reads the complete output of every command of the run, which can hold secrets;
  grant it as you would the right to read those commands.
- **`task:*-any`.** `TASK_CONTROL` cannot know which session is calling: the `-any` verbs trust
  the `sessionId` passed (agents' tools pass the calling one), so an extension with
  `task:read-any` or `task:cancel-any` can name any session of the run.
- **`sub-agents`** is provided by `agents`, not by the host, and write-only: `share` copies the
  arrays and validates each entry (an object with a non-empty string `name`; no duplicate, no name
  a sub-agent already gets), but does not freeze the tool and hook objects, which are held by
  reference. Nothing can read the shared lists. It is provided per consumer
  (`services.provideFor`) behind the grant `sub-agent:share`, which `agents` declares in its
  manifest's `services.grants`: `share` without it throws an `ExtensionUndeclaredError`
  (`use: 'grant'`). The grant is enforced by `agents`, not by the host
  ([services](../../extension/docs/services.md#services-an-extension-provides-per-consumer)).
  `share` does not check the shared names against the sharer's manifest `tools` and `hooks`.
  What a consumer shared is revoked when its scope is disarmed (it failed after sharing, was
  rolled back or stopped, or `agents` stopped): sub-agents started afterwards do not get it,
  sub-agents already running keep what they were given. A running sub-agent that starts a nested
  one gives it the lists as they are at that call, so a revoke is not carried into it.
- **Verbs reject, not throw.** A method that returns a promise (`cancel`, `runChild`, the output
  services) rejects with a refusal, as the output contract says, instead of throwing before it
  has a promise.

## The scopes and the node registry

Every session and every task is a node of the run's node registry (`@sheavly/runtime`, nodes), and
the scopes read and write it through the session and task registries, which are views of it: a
sub-agent is one agent node, a command or service a node under the session that started it. The
grants keep their meaning: they name what an extension may do to its own sessions and tasks, and
`-any` what it may do to the sessions and tasks of a session id it names (the service cannot check that id, as above). No scope hands out the node
registry, or a node id of someone else's: an extension that wants one for its own work asks for it
through the scope that started the work (a scoped node service for extension kinds is #433's).

**A release reaches an extension through `session-info`.** `onLifecycle` delivers
`session_released` when the run releases a session: the loop does it for a sub-agent as its report
is delivered (`releaseAgent`), and the registry releases the agent node, forgets the session's
queues and then announces it, in one call. Coding's file reads rely on it (`forgetAgent`), so a
release that skipped the announcement would leave a consumer holding what the session was shown.
`session-info-release.test.ts` runs a real sub-agent through the real loop and asserts that the
extension hears the release once, with the node gone. Release a session through
`SessionRegistry.release` or `releaseAgent`, never `NodeRegistry.release` directly: only the
former announces it.

**What a node's writer controls is not printed to the model as it is.** A title, a status, a
command or an error that a model, a tool or an extension wrote is printed through `escapedLine`, and
a body (a task's output, a sub-agent's report) through `escapeTags`. The `data` an extension's node
kind will carry (#433; no node has any today) is for front ends and must never be printed.
`harness/no-unescaped-model-text` fails the direct cases of the fields above; the cases it does not
see, and the text it does not cover (a tool's own error message, for one), are listed in
[the rules](../../eslint-config/docs/rules.md), and a test that passes a closing tag and a newline
through the place holds them.

## Testing a scope

`@sheavly/host/testing/scope-run.fake` (`scopeRun`) builds a real harness with the services as an
app builds them and activates fake extensions with the grants you give: `servicesOf(name)` is
the view of the services that extension was handed. `noSubAgentRuns`
(`testing/run-loop.fake`) is the loop runner for a test that never runs a sub-agent.

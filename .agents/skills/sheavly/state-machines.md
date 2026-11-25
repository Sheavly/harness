# State machines

Most of the harness's lifecycles are state machines nobody wrote down: a boolean, an optional field, map membership or "what history says". This is the catalogue of them as they are, the invariants each must keep, and the rule for adding one. Where the code has more than one vocabulary for one fact, that is stated as a divergence to remove, never as the design.

## How to treat a state machine

1. One table of states and transitions, in the module that owns it. Every other reader asks that module.
2. States that cannot coexist are a union, not several optional fields.
3. A terminal state is reached once. Cleanup runs on every path into it.
4. A test lists the transitions and the ones that must be refused.
5. A new kind of the same thing (a background-work kind, a notice kind) joins the existing machine; it does not get its own.

## The flow that must hold

The owner's model of how work flows. Tests state these as rules: every rule has tests whose titles start with its number ("rule 3: …").

1. The main session ends its turn when the model finishes, even while background commands or sub-agents run. When finite work finishes while the session is idle, the conversation starts a run on its own to deliver the notice (`wake` in `createConversation`), however many times in a row: unattended work has no cap unless the app sets `maxConsecutiveWakes`, and then `onWakeCapped` says each refused wake. Its events reach every UI through the combined stream. A sub-agent is the exception: its loop does not end while its own finite work runs (`holdOpenFor`).
2. Only `await_tasks` keeps the main session open: it stays open until the grouped tasks settle or the user stops it.
3. A line queued while the session is held on `await_tasks` stays queued until the model has finished.
4. Otherwise a queued line starts as the next prompt once the model finishes its turn.
5. Finished work reaches the model once, at its next model call, as a notice. Notices the model must remember are stored in history; transient ones (`context-usage`) ride one call and are never stored.
6. Services never hold a run open; only finite work can be awaited.
7. A sub-agent reports its own status and the parent can steer it; depth is bounded (`MAX_SESSION_DEPTH`).
8. A stopped run leaves history valid: every tool call has a result, even a placeholder.

### Where the code differs from these rules

The tests run through the real loop and conversation and are parameterised by kind (foreground tool, background command as `task` and as `service`, sub-agent). A test that states a rule today's code breaks is marked `it.fails`, so it turns red when the code is fixed and the fixing change must update it. Where a test titled "pinned today" sits beside it (rule 7, a stop while a prompt is prepared, and a stale file read), it holds today's behaviour and proves the setup works; the other defects have the `it.fails` test only.

- **Rule 7:** a steering message from the inbox enters history without an `id`, and the user-messages summary section drops it.
- **Stop while a prompt is prepared:** `Conversations.stop` only reaches a prompt that is past `preparePrompt`, so an earlier stop is ignored and the prompt runs to its end.
- **Outside the flow rules:** `FileReads` is not invalidated by `run_command`, so `edit_file` accepts a stale read; the backend gives the AGENTS.md hook only the workspace root, so a moved working root keeps the main checkout's file.

A change to any of these is a behaviour change: it lands as its own change, flips the matching test, and updates this section.

Rule 5 holds at the group boundary: `group()` throws `TaskError` (`task_delivered`) for a task whose notice was already delivered, and `await_tasks` shows the model that error as an error result. A task cancelled on request is silent and was never notified, so it can be grouped until the next model step releases it (a cancel and a group in one response both work). `groupMemberError` checks ownership before anything else about the task, so a foreign task's group, kind or delivery is never revealed, and a foreign id is refused exactly as an id that never existed or was released: `unknown_task` with `missingTaskMessage`, the answer `task_status` and `cancel_task` give.

A task's outcome is what its run reported. `TaskRegistry` records `completed` when the run resolved with exit code 0, even if a cancel aborted its signal before the settle ran: the registry cannot see whether the resolve or the abort came first, only the result. Any other end after an abort (no exit code, a failure code, a rejection) is `cancelled`. This is the same for every work kind. `cancel()` still marks the task silent, so a task cancelled after it finished returns `completed` to the caller and sends no notice; a grouped member stays in its group and reports its own status. A run that ignores the abort and then succeeds is recorded as `completed`. So that a cancel is never read as success, `runScript` returns no exit code (`null`) for a pipeline whose caller signal aborted while it ran, even when its last command had already exited 0. The report of a task that finished before its cancel is not delivered: it is only in what `cancel()` returns, which `cancelAll`, `cancelSession` and a sub-agent's shutdown discard.

Finished work is released, not kept for the life of the process. Before each model call (once per model step, not once per prompt), after the notices are built and in history, `reportFinishedTasks` calls `TaskRegistry.releaseFinished(sessionId)`: delivered tasks and silent settled tasks the session owns (or that have no owner) are forgotten, and a held group member stays until its group is delivered. A released id is unknown to `get`, `report`, `byCallId` and `list`; `isReleased(id)` tells it from an id that never existed (ids are sequential and never reused), though `group()`, `task_status` and `cancel_task` answer it exactly as they answer one that never existed (`missingTaskMessage`). The notice in history carries the task's snapshot and report, so nothing reads the registry again. Main-run shutdown releases nothing.

A delivered sub-agent's session is released in the same step, after the task release: for each delivered task that started a sub-agent (found by its call id), whatever its outcome, so a failed or stopped sub-agent with no report goes too, `reportFinishedTasks` calls `SessionRegistry.releaseAgent(id)` (`finishedTaskNotice` finds the sub-agent by its session, so the session can only go after the notice). A task cancelled silently never delivers, so its session stays. It releases the ended sub-agent and every session under it and announces each as `session_released`. It returns false instead of throwing, and does not retry, when a session in the subtree is still open, for a main session, and for an id already gone. The main session is never released: `Conversations`, resume and the HTTP routes read it after `close()`, and the registries are dropped with the conversation. A released id is unknown to `get`, `list`, `children` and the `stream` catch-up; `isReleased(id)` tells it from one that never existed, and `publish`, `publishTask`, `setModel`, `report` and `send` throw `session_released`. The registry keeps only the released id, its parent and its start time, so a subtree filter still matches the entries a released sub-agent left in the combined stream, which stay. Its stored history stays readable: the history tools search `releasedStarts()` too, all sessions in start order so a cursor survives a release. `message_agent` says the sub-agent was released. Release is in-process only: a reopened conversation restores every stored session.

A report that was not delivered when the process ended is not lost. The registry's `Entry.report` is in memory, but a sub-agent's report is `finalReply` of its stored history, so reopening re-derives it. `readStoredConversation` (host) asks `owedAgentReports` for every sub-agent of the main session that has no `agent-report` for its session, and no completion notice for its starting call (alone or in a `tasks-finished` group), in the repaired history. Each gets an `agent-report` notice appended after the repair placeholders: the report for a `completed` one, an empty report and its real outcome for any other, an open one counted as `interrupted`, and so is a completed one whose stored history is empty or cannot be read (a store error on one sub-agent never stops the reopen; it cannot tell a damaged log from a transient read fault, so the latter also loses that report for good, since the `interrupted` notice is logged and found delivered next time). Only direct children of the main session are owed: a deeper one reports to its own parent, whose history is not restored. The notice has no `taskId`, since task ids restart on reopen. `keeper.resumeWith` logs the appended entries, so reopening again finds them delivered and adds nothing. Reopening starts no run: the notice reaches the model once, at the next prompt (rule 5). A history written before notices existed gets them on its first reopen.

## Catalogue

| Machine                       | Where its state lives                                                                                                                                   | Known divergence or gap                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| ----------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Run                           | `packages/loop/src/stream-agent/stream-agent.helper.ts` (`reason`, the `done` event)                                                                    | no state variable: "over" means a `done` arrived. A run, failed ones included, ends with exactly one `done` and the session has left `running` before it; `max_turns` is chosen when the turn cap runs out, not a starting value                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| Turn                          | `packages/loop/src/stream-agent/turn.helper.ts` (`runTurn`, `finishTurn`)                                                                               | a fixed sequence of phases, tabled in `packages/loop/docs/run.md`; masking, overflow recovery and output limits are contributions, ordered once per run                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| End of run, as data           | `packages/protocol/src/status/status.constants.ts` (`STATUS_TABLE`), `runEnd`                                                                           | one table: `SessionState`, `RunOutcome`, `DoneReason`, `TaskStatus` and `TurnStopReason` are `z.enum` of its lists; a core `StopReason` is `TurnStopReason` minus `interrupted`; every end of a run is one `done`, and `runEnd(entry)` reads it                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| Tool call                     | `packages/loop/src/stream-agent/sample.helper.ts` (`settled`, the abort placeholder)                                                                    | state in an optional field and a race                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| Event queue                   | `packages/loop/src/queue/queue.service.ts`                                                                                                              | flags and counters (`closed`, `failure`, `consumerGone`)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| Session                       | `packages/runtime/src/sessions/sessions.service.ts`                                                                                                     | `sessionInfoSchema` rejects a snapshot whose `state`, `lastOutcome` and `endedAt` contradict each other; the registry still writes the three fields itself, so only parsing enforces it                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| Background task               | `packages/runtime/src/tasks/tasks.service.ts`                                                                                                           | a run that reports exit code 0 is `completed` even if aborted; `silent`, `delivery`, `group`, `#ready` mean "notified"; `start` still takes an optional owner, so only a direct call (a test) can leave a task to `cancelAll`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| Background work, as a concept | `WorkDefinition` kinds (`packages/runtime/src/tasks/work.utils.ts`), started by `startWork`                                                             | one registry per run, shared by every session (ids unique; a session's reads and shutdown are scoped to what it owns); the tool picks the kind (`run_command` finite, `start_service` service, `start_agent` agent: finite, named apart) and the kinds own the completion policy, asked through `isFiniteKind`; `WorkInput` requires the owner, and a foreign id reads as unknown in every task tool                                                                                                                                                                                                                                                                                                                         |
| Node                          | `NodeRegistry` (`packages/runtime/src/nodes/node-registry.service.ts`), `STATUS_TABLE.node`, and `NodeInfo` in `packages/protocol/src/node/`            | one lifecycle for every kind of node, in "Node lifecycle" below and the generated table: a move the table does not list is refused and a terminal state is reached once; the Session and Background task rows above are views of it, so they describe what `SessionRegistry` and `TaskRegistry` report                                                                                                                                                                                                                                                                                                                                                                                                                       |
| Notices                       | `packages/runtime/src/tasks`, the loop's delivery helpers                                                                                               | lifetime (transient or persistent) still decided at each call site; `hook-failed` is persistent, one per hook and handler, then a count                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| Approval                      | `packages/runtime/src/approvals` (`APPROVAL_TABLE`, `ApprovalStates`)                                                                                   | the runtime table is the one source of an approval's state (requested, then answered, cancelled or expired, once); a released session cancels its open approvals; command approval (the permission store, the workbook's `CheckApprovals`) and the apps' `unknown_approval` handling are still separate                                                                                                                                                                                                                                                                                                                                                                                                                      |
| Conversation run              | `packages/host/src/conversation/conversation.helper.ts`, table in `conversation.constants.ts`                                                           | one union, tabled below: `idle`, `prompt` or `wake`, moved only along `CONVERSATION_RUN_TRANSITIONS` (a move outside it throws `ConversationRunError`); `conversation.state` is the one answer to what runs, and the session's `running`/`idle` and the stream's `run_state` report it. Wake policy stays flags beside it (`wakesSuppressed` by a stop, `wakesDeferred` while a line waits, the yield's grace timer)                                                                                                                                                                                                                                                                                                         |
| Conversation input            | `packages/host/src/conversations/inputs.service.ts`, `prompt-queue.service.ts`                                                                          | a prompt being prepared (its skills) is a map entry until it starts or fails, and blocks a second; the queue's lines wait, oldest first, and one runner starts each when the run is `idle` and nothing is prepared. Lines a reopen restored, or a client put while none waited on a run, are parked until the next line is sent. Every change is a `queue` entry on the stream and a write of `queue.json`; a failed write is announced and the lines in memory still run. A line that cannot start is `prompt_refused` and dropped                                                                                                                                                                                          |
| Persistence                   | `packages/host/src/conversation/` keeper, `packages/storage/src/conversation-store/`                                                                    | a failed write is retried in order by `recover`, never sticky; crash consistency is a write order (stream first, derived files repaired on reopen), not a journal; writes across files are not transactional; a node's channel is the exception to retrying: a channel whose write failed takes no more entries (a log is never read as whole with one missing) and is closed as `lost` on reopen                                                                                                                                                                                                                                                                                                                            |
| Search backend cooldown       | `packages/tools/src/web-search-backends/fallback-search.helper.ts` (`coolingUntil`)                                                                     | two states, `available` and `cooling` until a time, tabled in the helper; a map entry means cooling and an expired one is only noticed on the next search. The backend app owns the chains in `SearchChains` (one per backend order, per backend, no module-level state)                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| Provider switch               | `packages/providers/src/switch/`                                                                                                                        | states and transitions are tabled in `switch.service.ts`; `remove` falls back to the first remaining provider; the active name is still set lazily by the first `add`, and `pinned()` freezes the mode at pin time                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| File access                   | `packages/runtime/src/locks`, `packages/workspace/src/file-reads`                                                                                       | `FileReads` is not invalidated by `run_command`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| Trust                         | `extensions/coding/src/trust/`                                                                                                                          | states tabled below, derived only by `decideTrust`; re-checked before each hook import, with the gap to the `import()` itself left open; `confineImports` is process-global on purpose; command approval is still spread (see Approval)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| Extension in the host         | `packages/extension/src/host/extension-states.service.ts`, table in `extension-state.constants.ts`                                                      | one state per extension, tabled below and guarded by a generated block in `packages/extension/docs/lifecycle.md` and a test. Divergence: the host has its own idle/activating/active/closed machine, and the result lists (`failed`, `skipped` with reason `dependency`) do not map one to one to the per-extension states                                                                                                                                                                                                                                                                                                                                                                                                   |
| Scoped service                | `packages/host/src/run-services/scope-guard.service.ts` (`ScopeGuard`), and the `disarm` of a per-consumer service an extension provides (`provideFor`) | one boolean, armed then disarmed: terminal, disarmed once, on every path into a terminal state of the consuming extension and when the provider stops. A throwing `disarm` is contained and reported (it never stops another disarm or a `deactivate`; its error is returned by `deactivate()` or listed in `lateDeactivationErrors`; when the activation fails, the next `deactivate()` returns what the closing contained, once; a `disarm` returning a rejected promise is collected best-effort when it settles, never awaited). What a consumer shared through `sub-agents` is revoked on its disarm: sub-agents started afterwards do not get it (a nested start sees the lists at its own call), running ones keep it |
| Instruction context           | `packages/core/src/instruction-context/` and its four hooks                                                                                             | state is read back out of history                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| Chat input                    | `apps/terminal/src/chat/chat-session.service.ts`                                                                                                        | no busy state of its own: a line is sent at once and the backend starts or queues it (Conversation input); what runs, the echo (`prompt_started`), the queue shown (`queue` entries) and each run's outcome (its main `done`, `runEnd`) come from the conversation's stream, so a stopped prompt is `interrupted`                                                                                                                                                                                                                                                                                                                                                                                                            |
| Terminal's task mirror        | `apps/terminal/src/client/conversation.service.ts` (`#countTask`)                                                                                       | a task is running (a map entry) or ended (a bounded id set, `ENDED_TASKS_KEPT`, oldest forgotten first); ended is final, so a start seen after its end, from the other of the two streams, is ignored. The state is per `RemoteConversation`, which follows one backend registry (ids are unique in it), so a reopened conversation starts empty. It only counts for the status line and is not a source of truth                                                                                                                                                                                                                                                                                                            |
| Workbook run                  | `apps/terminal/src/workbook/` run folder                                                                                                                | unfinished means `result.json` is missing; `beginRun` only claims a number (in a `DocumentFile.update` of the state file: queued here and locked across processes, so two never share one) and `finishRun` moves `last` once the result is saved, so a force-quit run is never `last` and `show` and `step` still read it                                                                                                                                                                                                                                                                                                                                                                                                    |
| Terminal Ctrl+C               | `apps/terminal/src/interrupt/interrupt.helper.ts` (`interruptOnCtrlC`, `abortingStop`)                                                                  | one policy for the demo, workbook and line chat: a press within `SAME_KEYPRESS_MS` is the same keypress; the first stops the work (`stopped`), a press while it is `stopping` runs the caller's cleanup and then exits 130, a press with nothing running (`idle`) leaves. Installed before the backend starts, so it stops a start too. The screen chat is raw keys, not a signal: its Ctrl+C asks `ChatSession.stop` the same question, and quits on `stopping`                                                                                                                                                                                                                                                             |
| Terminal's backend            | `apps/terminal/src/client/` (`connectBackend`, `stopProcessGroup`, `withBackend`, `closeSession`)                                                       | a started backend is stopped once (memoized): SIGTERM to its process group, SIGKILL after `BACKEND_STOP_MS`, an already-gone group (`ESRCH`) is a normal end; a start that fails or is interrupted stops its own child, because no handle reaches the caller. An entry point ends a session with `closeSession` (conversation, then backend, even if closing fails) and shares `openConversation`, `saveRawStream` and `describeFailure`                                                                                                                                                                                                                                                                                     |
| Dev hooks                     | `~/.cache/sheavly-harness/chats/<chat-id>.json`, `.git/cursor-docs-nudged.json`                                                                         | no schema, cleanup or locking                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |

`harness/no-adhoc-ctrl-c` enforces the Terminal Ctrl+C row: no `.on`, `.once`, `.addListener` or `.prependListener` of a literal `'SIGINT'` in the terminal app's source outside `interrupt.helper.ts`, so a new entry point uses `interruptOnCtrlC` instead of a fifth copy. It does not see a signal name held in a variable, the screen's raw `ctrl+c` key, or the order inside a caller's `forceQuit` (cleanup before exit is the helper's, tested in `interrupt.helper.test.ts`); those stay review-only.

This table is the starting inventory, read from the code. When you fix a divergence, update its row in the same change; when you add a machine, add a row.

## Conversation run

What a conversation runs now is `conversation.state` (`createConversation`,
`packages/host/src/conversation/`), moved only along `CONVERSATION_RUN_TRANSITIONS`;
`run-state.test.ts` lists the moves and the ones it refuses.

| State    | Meaning                                                         | May move to      |
| -------- | --------------------------------------------------------------- | ---------------- |
| `idle`   | nothing runs; a prompt may start, and finished work may wake it | `prompt`, `wake` |
| `prompt` | a user's prompt runs                                            | `idle`           |
| `wake`   | a run the conversation started itself to deliver finished work  | `idle`           |

- **One at a time.** A send while a run goes is refused (`session_running`) by the conversation;
  `Conversations.submit` queues the line instead, and its queue starts it once the run is `idle`.
- **What comes next is decided as the run ends.** Its history is kept, then the conversation
  wakes for finished work unless a stop holds wakes back, or a queued line waits or a prompt
  prepares its skills (`deferWakes`): that prompt then starts and delivers the notice. `whenIdle()`
  resolves after that decision.
- **Flow rules 3 and 4.** A queued line asks the run to yield; a run held on `await_tasks` ignores
  that until its grouped work has settled and the model has finished, then the line starts.

## Trust

A workspace's trust state is `decideTrust({ trustedFingerprint, currentFingerprint })` (`extensions/coding/src/trust/trust.utils.ts`); `TrustStore.check` and `list` both go through it. The fingerprint hashes every file under `.sheavly/`.

| State       | Meaning                                         | May move to                                                        |
| ----------- | ----------------------------------------------- | ------------------------------------------------------------------ |
| `untrusted` | no stored fingerprint                           | `trusted` (the user trusts it)                                     |
| `trusted`   | stored fingerprint equals the current one       | `changed` (a file under `.sheavly/` changes), `untrusted` (revoke) |
| `changed`   | stored fingerprint differs from the current one | `trusted` (the user trusts it again), `untrusted` (revoke)         |

`list` adds `gone` for a folder that no longer exists; it is not a state `check` can return.

- **Policy (#102):** code from a repo runs only in a trusted workspace; declarative content (skills, AGENTS.md) and user-level settings need no trust. An untrusted or `changed` workspace imports no hook file.
- **When it is checked:** at load, and again right before each hook file is imported. A change in between stops the load with a `ProjectHooksError`. The gap between that check and Node reading the file stays open.
- **Reload:** hooks load once per process and Node caches their modules, so a change to `.sheavly/` takes effect on restart, and needs the workspace trusted again.
- **Names:** a project hook named like a host hook (`hostHooks`) or an earlier project hook fails the load, naming both sources.
- **`confineImports`:** process-global on purpose. A loaded hook can `import()` lazily inside a handler long after loading, and that import must be confined too; a test pins it.
- **Timeouts:** `withDeadline` is the one definition of timed out for commands and scripts: the deadline aborted and the caller did not.

## Extension lifecycle

`ExtensionHost` holds one state per extension (`ExtensionStates`), moved only along
`EXTENSION_TRANSITIONS` (`packages/extension/src/host/extension-state.constants.ts`); a move not in
the table throws an `ExtensionStateError`. The table below is generated from the constants by
`extensionLifecycleMarkdown()` (`extension-state.utils.ts`) and pinned by a test in
`packages/extension`, which fails when it differs from the block in
`packages/extension/docs/lifecycle.md` or from this one. What each state means is in that file.

<!-- extension-lifecycle:start -->

| State         | May move to                        |
| ------------- | ---------------------------------- |
| `sealed`      | activating                         |
| `activating`  | verified, skipped, failed, stopped |
| `verified`    | merged, rolled-back, stopped       |
| `merged`      | stopped                            |
| `skipped`     | final                              |
| `failed`      | final                              |
| `rolled-back` | final                              |
| `stopped`     | final                              |

<!-- extension-lifecycle:end -->

A tool name is vouched for only once the extension is `merged`: `ServiceConsumer.contributedTools()`
is empty while it is `activating` or `verified` and again in every final state. This is a
behaviour change: it used to be filled before the merge, so for the rest of an activation an
extension could be attributed a tool another extension also contributed.

## Node lifecycle (the node registry owns it)

A **session** (the loop's view: `running`, `idle`, or one of six ended states) and a **background
task** (`running`, `completed`, `failed`, `cancelled`) used to be two machines for one thing,
joined for a sub-agent only by the tool call id. The wire model
(`packages/protocol/docs/wire-model.md`) has one **node** and one lifecycle for the root agent,
sub-agents, commands, services and the kinds an extension adds, and `NodeRegistry`
(`packages/runtime/src/nodes/`) is where it runs. The node's states are the `node` rows of the
generated table below (`STATUS_TABLE.node`). `SessionRegistry` and `TaskRegistry` keep their APIs
and are views of it: a session is an agent node, a command or service is a node of its own, and a
sub-agent's task is the agent node its session already is, so one sub-agent is one node. The
session and task rows describe what those views report.

- **One machine for every kind** (rule 5 above). An extension's kind (`<extension>.<name>`) uses
  these states and cannot add one, because every front end has to understand state. It can add
  status text.
- **A terminal state is reached once**, and the node's channel ends with one `closed` entry that
  carries it, the outcome and, for a command, the exit code. Cleanup runs on every path into it:
  a cancel, a failure and `lost` alike.
- **`lost` is not a live transition.** It is written only when a conversation is reopened, for a
  node whose channel has no `closed` entry because the server stopped, so it is reached from
  `running` or `idle` and never while the node is live. The registry writes it only through
  `lose`, which `SessionRegistry` calls for each sub-agent it finds open as it restores a stored
  conversation (the session reads as `interrupted`, the nearest state a session has); a live end
  goes through `endAgent` or `endWork`, which cannot produce it.
- **Stored node channels** (`NodeChannelWriter`, `packages/runtime/src/nodes/`). When a
  conversation is kept, each agent's, command's and service's channel is written to the store as it
  runs (`opened`, an agent's `updated`, `closed`), beside the stream, which is still the record. A
  write that fails leaves its channel as it was, so a log is never read as whole with an entry
  missing, and is announced once as `storage_failed` without ending a run. A node a reopened
  conversation restores has a new id: the channel the stopped process wrote for it stays, and
  `NodeChannelWriter.closeLost` (called when `Conversations.reopen` reads the store, before the
  conversation has a node of its own) ends every channel with no `closed` entry as `lost`, once;
  only the main agent, which goes on, begins a channel of its own. The kinds an extension adds are
  not stored. `NodeChannelWriter.follow` tells a follower each entry its channel
  takes from then on, once the store has it, with its `ordinal` (its place in the log, 0 for the
  first), and once more if the channel fails; what was stored before is the store's to read, and
  the ordinal is how a reader joins the two (follow, then read, then skip what the read held).
- **The stored tree channel** (`TreeChannelWriter`, `packages/runtime/src/nodes/`). The
  conversation's one tree channel is written beside the node channels, from what the node, task and
  approval registries do: `opened`, then `node_opened`, `node_updated` and `node_closed` for each
  agent, command and service, `approval_requested`, `approval_resolved` and `approval_cancelled`
  with the node that asked, the conversation's notices the host tells it (`queue_changed`,
  `prompt_started`, `prompt_refused`, `storage_failed`). Closing the conversation stops the writer
  (`stop()`) and does not close the channel: a closed channel takes no more entries, and a kept
  conversation is reopened under the same id and goes on from the last entry, so the tree channel
  has no `closed` entry while its conversation exists. Each entry is numbered as it is told (`s0`, `s1`, … with no gap) and written one after another. It
  keeps the tree the stored entries build (the protocol's `applyTreeEntry`) beside the cursor of the
  last, so `snapshot()` is the tree of exactly the entries the store has: a client that starts from
  it and follows after its cursor ends with what one that replayed the channel ends with. An entry
  holds at most what a store keeps: a command too long for it is cut, and an approval whose command
  was cut says so as a concern, so a client that shows only the tree never takes it for the whole
  command (the conversation's stream has the whole). A write that fails ends the channel as it was,
  and stopping ends it as it stands; `follow` tells the followers once either way. The fold keeps
  at most `MAX_TREE_NODES` nodes, dropping the oldest ended one nothing hangs from.
- **`idle` is for agents.** A command or service has no between-prompts state.
- **The outcome keeps the detail the state does not.** For an agent it is today's `RunOutcome`
  (`completed`, `interrupted`, `max_turns`, `max_tokens`, `context_window_exceeded`, `failed`), for
  a command its exit code.
- **How today's states map** (`NODE_STATE_OF_OUTCOME`; #438 left it open and #422 decided it). A
  session `running` and `idle` are the same. An ended session becomes the terminal state of its
  outcome: `completed` is `completed`, `interrupted` is `cancelled`, `failed` is `failed`, and the
  three limits (`max_turns`, `max_tokens`, `context_window_exceeded`) are `failed` with the limit as
  the outcome, since the work did not finish and a parent reading the state should not mistake it
  for success. A task's `completed`, `failed` and `cancelled` are unchanged. The node schema
  refuses an agent whose state its last outcome does not give, so the registry ends an agent with
  `endAgent({ id, outcome })` and the state follows from the outcome: an idle agent cancelled with
  `interrupted` closes as `cancelled`, and `endWork` refuses an agent, since a state alone leaves
  its outcome unsaid.
- **The protocol's status tests** (`status.utils.test.ts`) list every node transition and pin that a
  terminal state is final. What a table of states cannot say is held elsewhere: `idle` for agents
  only by the node schema and by the registry, which refuses `idle` and `resume` for a command, a
  service and an extension's kind, and `lost` only through `lose`. The registry's tests
  (`packages/runtime/src/nodes/__tests__/node-lifecycle.test.ts`) run every kind through the same
  table and show a terminal state is reached once on every path, an end after a `lose` and a `lose`
  after an end included, as "How to treat a state machine" says.
- **What a title and a status are.** A node's title and status text are one line of plain text, not
  blank and capped, on the wire. The registry makes them so as it makes or changes a node, because
  a command's description or an agent's status report can be anything: newlines and escape
  sequences become spaces, a title left empty becomes `untitled`, and a status with nothing in it
  changes nothing; a tool call's id is cut to the wire's cap. A session is not rewritten by this:
  `SessionRegistry` keeps the title, status and call id it was given and reads them back as given
  (a newline, a zero-width joiner in an emoji or in Persian text, a blank status), and only its node
  holds the copy made fit for the wire.

## The status table

Generated from `STATUS_TABLE` (`packages/protocol/src/status/status.constants.ts`); a protocol test fails when this block differs from it. A run is a session's `running` stretch, so there is no separate run machine: a run's outcome is the ended state its session takes, and its `done` carries it.

<!-- status-table:start -->

| Machine | State                     | May move to                                                                             |
| ------- | ------------------------- | --------------------------------------------------------------------------------------- |
| session | `running`                 | idle, completed, interrupted, max_turns, max_tokens, context_window_exceeded, failed    |
| session | `idle`                    | running, completed, interrupted, max_turns, max_tokens, context_window_exceeded, failed |
| session | `completed`               | final                                                                                   |
| session | `interrupted`             | final                                                                                   |
| session | `max_turns`               | final                                                                                   |
| session | `max_tokens`              | final                                                                                   |
| session | `context_window_exceeded` | final                                                                                   |
| session | `failed`                  | final                                                                                   |
| task    | `running`                 | completed, failed, cancelled                                                            |
| task    | `completed`               | final                                                                                   |
| task    | `failed`                  | final                                                                                   |
| task    | `cancelled`               | final                                                                                   |
| node    | `running`                 | idle, completed, failed, cancelled, lost                                                |
| node    | `idle`                    | running, completed, failed, cancelled, lost                                             |
| node    | `completed`               | final                                                                                   |
| node    | `failed`                  | final                                                                                   |
| node    | `cancelled`               | final                                                                                   |
| node    | `lost`                    | final                                                                                   |

<!-- status-table:end -->

## Enforced

- **One main-session definition** (`harness/no-adhoc-main-session`): no `session.depth === 1` in source. The main session is the one without a parent: `isMainSession` (`@sheavly/protocol/session/session.utils`). How the main run ended is `runEnd(entry)` (`@sheavly/protocol/status/run-end.utils`), never a hand-matched `done` or `session_idle`. It sees only a comparison of a `.depth` member with the literal 1; a depth copied into a variable first, or a `done` matched by hand, is review-only.
- **One "no longer waiting" rule** (`harness/no-adhoc-unknown-approval`): no `'unknown_approval'` string in source. A UI's answer that finds its approval gone (answered elsewhere, or its call interrupted) is forgiven once, by `answerWhileWaiting` (`@sheavly/client/approvals/approvals.helper`), which the chat and the workbook's `CheckApprovals` use. The client helper, the protocol's error list and the backend's error mapping are `files:` overrides. It matches the literal only: the code read through a variable is review-only.
- **One notice lifetime** (`harness/no-adhoc-notice-entry`): no `{ role: 'notice' }` entry written by hand in source. A notice kind is transient or persistent in `NOTICE_LIFETIMES` (`@sheavly/protocol/notice/notice.constants`), and `publishNotice` (`packages/loop/src/stream-agent/notice-publish.helper.ts`) sends the event and keeps the entry only for a persistent kind. A new kind is its schema plus one registry entry; `NOTICE_SAMPLES` (`@sheavly/testing/notice/notice-samples.fake`) then runs it through the formatter, history, stream and `publishNotice` tests. `publishNotice` and `noticeEntries` (the same file) are the one `files:` exception; restored reports use `noticeEntries`. An entry built from a variable role is review-only.
- **The status lists** are derived from `STATUS_TABLE`; `status.utils.test.ts` pins every pair and that each enum equals its list, and `status-guide.test.ts` that the table above is the table.

## Adding or changing one

- Find its row. If it exists, change the machine, not a caller.
- If the fact you need is already encoded another way, derive the new form from the owner instead of adding a vocabulary.
- Say in the PR whether the change moves a transition (a behaviour change) or only restructures.
- Add the transition test before the change when the machine had none.

# Scoped services

An extension never holds a `SessionRegistry`, a `TaskRegistry` or the `NodeRegistry` they are
views of (`harness/extension-no-runtime-registries` reads the registries from the host's `Harness`
type, so the node registry is denied without being named): the node registry reaches every node of
the conversation, which skips the scoping below. The host builds, per extension,
a narrow service whose type is declared here (`@sheavly/runtime/sessions/session-scope.types`,
`@sheavly/runtime/tasks/task-scope.types`) and whose methods each check a **grant**: a
`<noun>:<verb>` string in the extension's `sheavly.json` `grants` list. The host implements the
types; this package only defines them. A grant limits what the service does for an extension,
not what Node code can do: this is least privilege, not a sandbox.

## Sessions

| Type                | Service          | Grants checked                                                                                                                                           | What it omits                                                                                              |
| ------------------- | ---------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------- |
| `SessionInfoView`   | `session-info`   | `session:read`                                                                                                                                           | message content, inboxes, every write, `RunSession`                                                        |
| `ChildSessionScope` | `child-sessions` | `sub-agent:create` (`startChild`, `setModel`, `runChild`), `sub-agent:message` (`send`), `sub-agent:observe` (`onUpdate`), `sub-agent:report` (`report`) | `publish*`, `end`, `idle`, `resume`, `release*`, `subscribeEntries`, `stream`, notices, `'user'` as sender |

- `SessionInfoView.onLifecycle` delivers `{ type, session }` for `session_started`, `session_idle`,
  `session_resumed`, `session_ended` and `session_released` only.
- `ChildSessionScope` acts only on children it started: the parent of `startChild` is the main
  session or an owned child, and `send` comes from the main session or an owned child. What it
  returns is a frozen copy of its own record, so a ref cannot be changed to name another session.
- `runChild` owns the plumbing into the loop. The scope builds the `RunSession` and passes the full
  registries to the loop itself, and cancels the child's tasks when it ends; the extension never
  holds either. Its parameters are those of the loop's `runSession` minus `tasks` and `session`,
  plus the `child` it started and `onRunEnd`, called when the loop has returned and before the
  cancel. It refuses a child that is not owned, has ended, or is already running.
- No scoped service hands out `publish`, `queueNotice` or `publishTask`. `send` and `report` do
  produce session updates, and a child's loop publishes its events.

## Background tasks

| Type                  | Service            | Grants checked                                                                                              | What it omits                                                                 |
| --------------------- | ------------------ | ----------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------- |
| `BackgroundTaskScope` | `background-tasks` | `task:start` (`start`), `task:read` (`get`, `report`, `list`, `observe`), `task:cancel` (`cancel`, `group`) | other extensions' tasks, `cancelAll`, `cancelSession`, deliveries, `release*` |
| `TaskControl`         | `task-control`     | `task:read-any` (`getOwned`, `list`, `report`), `task:cancel-any` (`cancel`, `group`)                       | `start`, `cancelAll`, `cancelSession`, deliveries, `release*`                 |

`TaskControl` is what the `task_status`, `cancel_task` and `await_tasks` tools do to every task of
the calling session, whatever started it. Its `sessionId` is always required, because
`TaskRegistry` reads an absent one as every task of the run. The scope cannot know the calling
session: the `-any` verbs trust the `sessionId` passed, so `task:*-any` lets an extension name any
session of the run.

## Starting work

`startWork({ tasks, work })` takes a `TaskStarter` (`{ start(work: WorkDefinition) }`), which both
`TaskRegistry` and `BackgroundTaskScope` satisfy. It stays the only source file that calls
`start`, so a work kind's policy is still decided by its factory (`harness/no-direct-task-start`).

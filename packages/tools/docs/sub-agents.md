# Sub-agents

The `start_agent`, `report_status` and `message_agent` tools. The session tree, inboxes and the event stream they build on are in [@sheavly/runtime](../../runtime/docs/sessions.md).

## Sub-agents

`createSubAgentTool(options)` (`@sheavly/tools/sub-agent/`) is the `start_agent` tool: it starts a
sub-agent on one task, `{ title, task }`.

- **A background task.** The sub-agent runs as a task of kind `agent` (finite work, named apart so
  a UI can count it separately from commands and services) in the parent's `TaskRegistry`, so the
  parent sees it with `task_status`, stops it with `cancel_task` (its session ends as
  `interrupted`), and is told its report when it finishes. Its task requires completion:
  the parent prompt stays alive and resumes automatically with the report. No user message or
  status polling is needed. The child's run also waits for its finite tasks by default; persistent
  commands are started with `start_service` and can outlive a prompt. Interrupting the
  parent's run cancels its background work, including unfinished sub-agents.
- **Three levels, hard cap.** Main session → sub-agent → sub-agent (`MAX_SESSION_DEPTH = 3`).
  Below the cap a sub-agent gets `start_agent` too; at depth 3 it doesn't, and the registry
  refuses a fourth level regardless.
- **The parent chooses.** `options.tools` and `options.hooks` are what sub-agents get, and none of
  those tools may share a name with one the sub-agent adds: `report_status` always, the task tools
  (`task_status`, `cancel_task`, `await_tasks`) when it can nest or `withTaskTools` is set, and
  `start_agent` and `message_agent` below the depth cap. A clash fails the sub-agent's run with a
  `DuplicateToolError` before its first model call, and the parent is told the task failed. The parent's own hooks are not inherited unless
  listed. Each sub-agent runs its own `sessionStart`.
  `options.baseInstructions` supplies shared guidance before the child role;
  `options.instructions` adds child extras after it. Outer whitespace is trimmed, blank sections
  are skipped, and sections are joined with one blank line. The same
  composition is passed to descendants. Neither option implicitly copies parent history or
  conversation overrides. The backend supplies its shared generic and coding text explicitly.
- **Tools that start background tasks.** A tool such as `run_command` goes in `options.tools`
  like any other, built on the run's one `TaskRegistry`, shared by every session, so task ids are
  unique across them; set `options.withTaskTools` so sub-agents get the task tools at the depth
  cap too. What a sub-agent starts is owned by its session: `task_status`, `await_tasks` and
  `cancel_task` see only that, a foreign id reads as unknown, and its background commands stop
  when it ends (`cancelSession`), leaving its parent's and siblings' running. A sub-agent
  below the cap has the task tools anyway; `withTaskTools` is read when each sub-agent starts.
- **Approvals.** A sub-agent's tools ask the user through the same approval registry as the main
  session; the request carries the sub-agent's `sessionId`. A UI names the asker from the
  session updates: see `watchApprovals` in [@sheavly/client](../../client/docs/design.md).
- **Its own context.** A sub-agent sees only its task, not the parent's conversation.
- **Scopes.** The tool reaches the run through `options.scopes` (`SubAgentScopes`): `children`
  (a `ChildSessionScope`: `startChild`, `setModel`, `send`, `report`, `onUpdate`, `runChild`),
  `tasks` (a `TaskStarter`, so work still starts through `startWork`), `taskControl` (what the
  task tools act through) and `sessions` (a lookup). They are the structural types of
  `@sheavly/runtime/sessions/session-scope.types` and `tasks/task-scope.types`, so the tool
  holds no registry, and `runChild` owns the plumbing into the loop: it keeps the history before
  and after the run and stops the child's own tasks when it ends. The tool passes `onRunEnd` to
  stop listening to the child first, so what cancelling those tasks produces never reaches the
  task's output. Tools can't import the loop, so
  the loop's `runSession` is never an option: whoever builds the scopes (the host's
  `child-sessions` service) holds it. A test below `host` builds scopes straight over its
  registries with `registryScopes` (`@sheavly/tools/testing/registry-scopes.fake`).
- `start_agent`, `report_status` and `message_agent` only work inside a session: called without
  one (`context.session` unset), they fail with a `ToolCallError` (`reason: 'unavailable'`).

## Keeping a sub-agent's history

`options.keepHistory({ session, messages })` is how the app records a sub-agent's history. It is
called with the history so far, whole, before the run (so a crash does not lose the task) and again
when the run ends, whatever the reason, and is passed on to the sub-agents it starts. The tool
stores nothing itself; the receiver appends only what is new. The backend sends it to the
conversation's per-session history log.

## Searching the history

`createHistoryTools({ sessions, logOf })` (`@sheavly/tools/history/`) gives the agent
`search_history` and `read_history_entry`: the way back to original entries a summary replaced,
across the main session and its sub-agents. A search is bounded (default 10, at most 25) and
paginated by a cursor; each result carries its session and entry number, and `read_history_entry`
returns one entry whole (cut with a note when very long). Everything retrieved is recorded data:
excerpts have tag characters swapped and a read is fenced and framed as data, never as an
instruction. The app decides which sessions exist and where their logs are; the backend adds the
tools to a kept conversation's main run only.

## Reports

What a sub-agent reports is its final answer, and the parent gets it whole, with no size limit.
`finalReply` takes the unbroken run of assistant messages that ends its last reply and joins them
in order with nothing between, because after an output-limit cut the continuation resumes
mid-text. What it said before its last tool call is work in progress and is left out, and so are
the `[status]` and `[message]` lines. A sub-agent that wrote no text gives a placeholder, so the
parent never gets a blank result.

`runChild` returns it as the task's `report`. The task registry keeps it outside the output
preview and outside `TaskInfo`, so the process-output limits never touch it, no event carries it
as part of the task, and `task_status <id>` shows it whole. The bounded preview still holds the
status lines and the end of the report for a UI card. Ordinary background commands keep their
bounded output. The `start_agent` and `task_status` descriptions say the report arrives whole.

## Status reporting

Every sub-agent gets `report_status({ status })`, and its instructions tell it to call it
before it starts and at each new step: "reading files, reading core package", then "editing
core package", then "updating ESLint rules". It's the sub-agent saying what it does, not the
harness watching its tool calls.

Each report updates the session in the registry, which tells its listeners
(`sessions.subscribe`) and adds a `[status] …` line to the task's output for the parent, which reads
it through `task_status` and a finished sub-agent's notice. A status is written by a model or by an
extension, so the line is one escaped line (`escapedLine`): no tag, no line break, no control
character. A steering message sent to the sub-agent is copied the same way as a `[message] …` line
with its tags escaped and its line breaks kept. `message_agent` prints the target's title as one
escaped line as well.

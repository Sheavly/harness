# The task tools

`createTaskTools(tasks)` (`@sheavly/tools/tasks/`) returns three tools that act through a
`TaskControl` (`@sheavly/runtime/tasks/task-scope.types`: `getOwned`, `list`, `report`, `cancel`
and `group`, each for the session of the call; a whole `TaskRegistry` is still accepted and read
through the same calls), for background work: commands started with
`run_command`'s `background: true` ([@sheavly/coding](../../../extensions/coding/docs/run-command.md)) and
sub-agents ([sub-agents.md](sub-agents.md)), which run as tasks too.

| Tool          | Input             | What it does                                                                                                     |
| ------------- | ----------------- | ---------------------------------------------------------------------------------------------------------------- |
| `task_status` | `{ id? }`         | Immediate inspection: one task's status and recent output (or complete sub-agent report), or a list of all tasks |
| `await_tasks` | `{ ids, reason }` | Immediately registers a completion group; holds notices until every member finishes                              |
| `cancel_task` | `{ id }`          | Stops a running task and waits until its process has exited                                                      |

- The agent doesn't need `task_status` to wait: the loop reports finished tasks once at turn
  boundaries. Finite tasks, including sub-agents, keep the run alive automatically by default.
  Persistent commands are started with `start_service` and need not exit before the
  agent finishes ([@sheavly/loop](../../loop/docs/run.md)).
- Status calls are immediate snapshots for requested updates or diagnosis, not waits. The
  description and every running snapshot tell the agent not to poll: finish independent work,
  then end a turn without tool calls to let the loop wait for required results.
- `await_tasks` is optional and rarely needed: every finished finite task is delivered and wakes
  the agent without it, so its description and result tell the agent never to call it for one task or
  just to wait, only to hold two or more results back until they can arrive together. It
  requires at least one id and a trimmed, nonempty `reason`. The reason explains
  why the results belong together and what decision or next step depends on them, so the agent's
  future self can use them after a summary. Guidance rejects lazy reasons such as "waiting for
  results"; validation checks presence and nonempty text, not a brittle wording rule.
- Group registration returns immediately. `TaskRegistry.group` validates unknown ids, duplicates,
  existing group ownership and tasks whose notice was already delivered atomically: an invalid
  call claims no members, and the model sees the refusal as an error result. The tool forwards
  the calling session id when available, and registry errors become tool error results. The
  registry holds grouped completion notices until all members settle, then the loop delivers
  the results together with the reason.
- The task tools need a session (`context.session`): the run's tasks share one registry and a
  session sees only its own, so a call with none is refused (`reason: 'unavailable'`) rather than
  shown every session's tasks. An unknown status or cancellation id is a `ToolCallError`
  (`reason: 'not_found'`), and it reads the same for an id that never existed, one another session
  owns and one already reported and released (its notice in history holds what it reported), so an
  id reveals nothing about another session's tasks. `await_tasks` gives the same answer for the
  same three cases (`unknown_task`, one message shared with the status and cancel tools). Cancelling an
  already finished task returns its status without an error, and so does a task whose run
  finished (exit code 0) just as the cancel arrived: it is `completed`, not `cancelled`. A command
  stopped by the cancel has no exit code, even a pipeline whose last command had already exited 0.
  Ungrouped cancellation suppresses the completion notice because the caller already knows, so a
  task that finished first shows its report only in the cancel result; cancellation of a grouped
  member is handled by the registry so it does not bypass the group's delivery semantics.
- A UI that wants them includes them; a run without background work can leave them out.

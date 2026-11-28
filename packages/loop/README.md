# @sheavly/loop

The agent loop: `streamAgent` runs one session's turns, calls the model, runs tool calls in
parallel inside the run's hooks, and emits typed events in causal order with a gap-free `seq`.
`runAgent` runs it to the end and returns the history; `runSession` is the same for a sub-agent.
It knows the core contracts and the runtime registries, and nothing about files, workspaces or
which tools a run has.
Each attempted model call emits one `usage` event before its `turn_end`, including failed or
interrupted calls with unknown usage. These statistics are for UIs and are not model history.

The model receives context counts as a typed harness notice, formatted by its provider with
explicit telemetry attribution and silent-use guidance. Notices stay outside stored history and
system instructions. The same data is emitted as a `harness_notice` event for UIs, which choose
their own presentation; existing usage events are unchanged. See [context usage](docs/run.md#context-usage).

While tasks run, each call also receives a transient `running-tasks` snapshot from the registry,
not from history. It includes session-compatible services, the 10 most recent tasks, bounded
launch titles and reasons, start times, group identity, and total/omitted counts. The identical
payload reaches UIs as `harness_notice`; neither it nor its formatted text reaches history or
summarizers. See [running tasks](docs/run.md#running-tasks).

Output truncation automatically continues the task by default. A transient `output-continuation`
notice accompanies context telemetry on the next request and is emitted to every UI through the
same event stream. Partial replies and completed tools stay in history; recovery instructions do
not. Cancellation and explicitly configured run limits still apply, and repeated cut-offs that
keep no text or tool call end the run as `max_tokens`. See [output-limit recovery](docs/run.md#output-limit-recovery).

```ts
import { streamAgent } from '@sheavly/loop/stream-agent/stream-agent.helper';

for await (const event of streamAgent({
  provider,
  tools,
  hooks,
  messages,
  signal,
  tasks,
  session,
})) {
  render(event);
}
```

| Module          | What it holds                                                                                                                                                                                                           |
| --------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `stream-agent/` | `streamAgent`, `runAgent`, `runSession`: the turn, one model call, tool calls                                                                                                                                           |
| `errors/`       | `StreamEndedError` (the stream ended without `done`), `HookError`, `InvalidHistoryError` (a `beforeModelCall` result that breaks the history rules), `SummaryRejectedError` (a summary that broke the checkpoint rules) |
| `summary/`      | The default summary policy and the pure policy: `shouldSummarize`, `chooseCut`, `viewOf` (what a model is sent for a history with checkpoints)                                                                          |

Finished-task notices retain their reason, start time, duration and the count of stored user
messages since the task began. Group deliveries include both aggregate and per-member context;
ungrouped tasks use their launch description when no grouping reason was supplied. Counts come
from append-only history, not the shortened model view. Starting-call references are shown only
while that assistant tool call remains in the view; stored notice snapshots are never rewritten.

Internal (closed in `exports`): `events/` (the event bodies), `queue/` (the `OrderedQueue` every
event goes through), `hooks/` (running each hook point), `history/` (`assertValidHistory`, the
one check for the messages a model call sends), `abort/` and `items/` (`ReplyItems`, which turns
a model call's chunks into the item events the loop tells the session registry beside its events;
see [items](docs/run.md#items)).

## Docs

After cleanup and error hooks, a failed run emits `run_failed` before its failed session update.
It carries the error message, session and selected diagnostic details. The iterator still throws
the original exception. Diagnostics can be linked to the originating user message through the
session stream, never inserted into model history.

- [A run](docs/run.md): one run from start to end, hook order, interrupts and failures.

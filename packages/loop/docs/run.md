# A run

What `streamAgent` does from start to end, how it runs hooks, and how a session's events are ordered.

## Failure diagnostics

After cleanup and error hooks, `run_failed` carries the error message, session and selected details:
name, system code or provider reason, stack and up to four causes. The stack is limited to 16,384
characters and each cause message to 8,192. Common credential forms are redacted. No exception,
request or response object is serialized. The event reaches subscribers before the failed session
update; the original exception still ends iteration. Diagnostics never enter model history.

## From start to end

`streamAgent(options)` returns an async iterable of events, each with a gap-free `seq`:

1. `sessionStart` hooks run (they may add context).
2. Each turn: messages sent to the session meanwhile (steering) are added, finished background
   tasks are reported, a summary is written if the `summary` option is set and the context
   nears the window ([Summaries](#summaries)), `beforeTurn` hooks run (they may add
   context and this turn's system instructions), `beforeModelCall` hooks run (they may replace
   the messages this one call sends), then the model is called. Text and reasoning stream out as
   they arrive. A provider's `reasoning_activity` signal goes out through the same queue as
   deduplicated start and end transitions, and the loop ends one a cut stream, abort or failure
   left open. It never enters history. A provider that cannot reach its backend says so with
   `model_connection` (`offline`, `provider_unreachable`, `restored`) before anything of the
   reply, and the loop sends it on as it comes, in order, without it ever entering history: the
   call is only slow, so the run, its tools and its sub-agents go on as soon as the provider gets
   through, and fail only when the provider gives up.
3. Tool calls start the moment the model asks for them, each wrapped by `aroundToolCall` hooks.
   Their results are released after the turn ends (`tool_batch`, then one `tool_result` per call),
   each as its tool finishes, so a fast tool is not held behind a slow one called before it.
   Results that finished while the model still streamed go out first, in the order they finished.
   A UI matches a result to its call by id; `tool_batch` lists the calls in the order the model
   made them, and the history the model is sent next keeps that call order.
   A `tool_result` can carry `artifacts`, the tool's data for a UI (a file write's before and
   after, which lines a read covered); the model sees only the text, a UI renders these.
4. `afterTurn` hooks run. Output truncation gets a bounded continuation; otherwise, if the model
   called tools, the next turn starts. Without either, the run ends (or waits for a background
   task). A session cannot end normally while its non-service tasks, including sub-agents, are
   running or have results ready to deliver. Services (the `service` kind, started by `start_service`) may outlive it.
5. `done` is always last and carries the full history, valid to continue from, and the run's
   session (every run is a session with an id; see [sessions](../../runtime/docs/sessions.md)).

The automatic wait begins only after a turn without tool calls. What it waits for is
`holdOpenFor`: `finite` (the default, a sub-agent's) waits for any running finite task, so a
sub-agent never ends while its own work runs; `awaited` (a conversation's main session) waits
only for `await_tasks` groups, and other finished work is delivered by the run the conversation
starts when it finishes. A ready notice at the end of a turn continues either run once. Repeated status-tool calls keep
starting model turns instead of waiting; the agent must finish independent work and yield.
A task completion wakes that wait and reaches history before the next model call, without
another user prompt. `await_tasks({ ids, reason })` returns immediately and holds those tasks'
notices until every member finishes, then delivers one `tasks-finished` notice containing the
reason and individual results. An ungrouped task is delivered on its own. Finishes during a model
turn are reported at the next turn, never inserted into a call already in flight.

A message sent to the session (a parent agent's) wakes the existing inbox wait without cancelling
tasks or releasing held groups. Normal completion rechecks the inbox after the final asynchronous
task check, so a message accepted at that boundary is handled instead of stranded in an idle
session. Aborting `yieldSignal` ends the run as `completed` at its completion point instead of
waiting for tasks: it wakes the wait and takes precedence over pending deliveries, which stay for
the next run. It never interrupts a model call or tools, and it never ends a hold on grouped work
(`await_tasks`): while grouped tasks run, the yield stays raised and is ignored, so a queued line
waits until the model has finished (`yieldEnds`). When the group settles, the model still
receives its notice and answers it; the raised yield then ends the run at the next completion
point, and the queued line starts as the next prompt. Cancelling a grouped task counts it as
finished, but the combined notice waits for the remaining members and includes its cancelled
status. Services that outlive a run are reported
at the next prompt; grouping a service does not turn it into finite work.

**A finished task is a persistent notice.** For each task that finished, the loop emits
`task_completed` (the snapshot), then a `harness_notice` carrying a typed notice, and stores the
same notice in history as a `notice` entry (`finishedTaskNotice`, `stream-agent/`). A sub-agent,
found by the session its task runs (`start_agent` records it as the task's `agentSessionId`, and
the loop reads it from the task's snapshot, never by the tool call id, which a provider may
repeat), is an `agent-report`: its card (id, title, parent,
depth, model, status, how it ended) and the report it wrote, whole. Any other task is a
`task-finished`, with its bounded output preview. The model is sent the notice as a user-role
message holding the core formatter's text inside the `<harness-notice>` envelope, never as a
person's prompt, so it is not pinned as the latest request and a summary treats it like any older
message. A UI reads the same data from the event or from history. See
[harness notices](../../protocol/docs/contract.md#harness-notices).

Every new completion notice includes a `context` snapshot: the explicit grouping reason (or
an ungrouped task's launch description), `startedAt`, `durationMs` and `userMessagesSinceStart`.
The count includes stored user-role messages with timestamps strictly after the task started,
including entries hidden by summaries; an entry without a timestamp is not counted, and rendered
notices or checkpoints are never counted as user messages. Pending inbox messages are added
before the snapshot, so a message arriving with a completion is included. Counts stop at
notice delivery; a task's duration stops at its own settlement even when its group waits longer.
A group's context spans its earliest start to its latest settlement and counts messages since
that earliest start. Every member also keeps its own timing and count.

The context's `callId` is included only if the starting assistant tool call is visible at
delivery. If a later checkpoint hides that call but keeps the notice, the model formatter's
view omits the pointer without changing stored history or the arrival-time measurements. This
also handles a summary written in the same turn as delivery. Task and agent snapshots still
retain their identity links for UIs.

The view is built once, by `viewOf`, and `beforeModelCall` hooks receive exactly the text the model
is sent, pointers included. Nothing is rewritten after the hooks: a hook that removes the
assistant call but keeps the notice leaves the pointer naming a call that is no longer in the
input, which is harmless data. No notice envelope is parsed from user or hook-authored text, and
stored snapshots remain unchanged.

Each event also joins its session tree's combined stream the moment it is released
(`sessions.publish`), so a UI following every session at once (`sessions.subscribeEntries`) sees
a sub-agent's activity in the same order as its parent's: a sub-agent's start comes after the
`tool_call_started` that launched it. An event with nothing waiting ahead of it is released as it
happens; one queued behind a pending tool result waits for it, as in the run's own stream.

Aborting the signal stops cleanly at any point: unfinished tools get an "interrupted" result, so
history stays valid. Every running background task, including services and sub-agents, is cancelled
before the session ends; sub-agents cancel their own running descendants. Unfinished work is not
left running to return on a later prompt. Cancellation is registry-wide, so concurrent runs and
parent/child loops must not share one `TaskRegistry`; the sub-agent factory creates a distinct
registry for each child. If the run fails, `onError` hooks are told and the error is rethrown; an
`onError` handler that fails is reported as a `hook_failed` event, never in place of that error. A
model call that fails after it started tools (a cut-off stream, an error event) first stops those
tools and emits their results, so every `tool_call_started` is answered, then fails the run.

When the run is over its session ends with the outcome (`completed`, `interrupted`, `max_turns`,
`max_tokens`, `context_window_exceeded`, `failed`). With `keepSession: true` it goes idle instead, keeping the outcome as `lastOutcome`, so
a conversation's next prompt can resume it; the host ends it when the conversation closes.

## Items

Beside its events the loop makes **items**: what a model call said, in pieces that start and
complete (`ItemEvent`, `@sheavly/protocol/item/`). A provider marks no boundaries, so the loop
derives them from the order of the chunks it already sees (`ReplyItems`, `items/`), one model call
at a time:

| Item        | Starts when                                  | Completes when                                                          |
| ----------- | -------------------------------------------- | ----------------------------------------------------------------------- |
| `message`   | the first non-empty text of the reply        | a reasoning or tool call chunk follows it, at the cap, or the call ends |
| `reasoning` | the `reasoning` chunk arrives, whole         | at once                                                                 |
| `tool_call` | the model's call arrives, as the tool starts | the tool settles, or it is stopped                                      |

- **Ids** are minted by the loop (a lowercase UUID per item), never taken from a provider, whose
  call ids repeat. A tool item carries the provider's id as `callId` only when it is 1 to 200
  characters, never cut, and `turn`, the ordinal of the model call in the run.
- **A message holds at most 8,192 UTF-16 code units.** A chunk that would pass the cap is split:
  what fits is a delta, the message completes, and the rest starts a new one. A split never falls
  inside a surrogate pair, and a chunk that ends in a lone high surrogate waits for the next one
  (still alone when the message completes, it is replaced with U+FFFD), so no delta holds half a pair.
  Each delta says the `offset` of the text before it. `reasoning_activity` and `model_connection`
  are not content: text on either side of one is one message.
- **A tool item completes when its tool settles**, not when the turn releases the result, so a
  fast tool's item is complete while the model still streams. It holds the call's input and its
  result, or, for a call that launched a node, the task and the node and no result. A tool stopped
  before it settled holds the placeholder result history holds: `interrupted` when the user
  stopped the run, `failed` when the model call it came from failed.
- **A message's reason** is `completed`, `interrupted` (the run was stopped, or the connection was
  lost, while it streamed) or `failed` (any other failure of the model call, or the model ending
  the call with `context_window_exceeded`, after which the loop may drop the reply and try again:
  the message was told as it streamed, so it says how the call ended, not whether the loop kept
  the reply). A message cut by a stop keeps its partial text. After a lost connection the turn that goes on makes new items, with
  new ids, and the tools the cut call started keep running.
- **Order.** A message completes after the model call's last chunk and before that call's `usage`
  event; the Messages mapping sends its reasoning when the reply ends, so that item is the last of
  the reply.
- **Where they go.** Each item event is told to the run's session registry at the moment it
  happens (`SessionRegistry.publishItem`, heard through `subscribeItems`), so a listener hears them
  in the order the loop made them. They are not in the ordered event queue: the events, their
  `seq`, `tool_batch`, the release of results and the combined stream are as they were, and no
  item is ever an entry of the stream. Every item of a run is told before its `done` reaches the
  consumer: the turn waits for the tools it started, a stopped or failed call's included, before
  it ends or rethrows. An item of a session the registry no longer knows is dropped, and costs the
  run nothing: the run fails at its next event, as before. Each listener is handed a frozen copy,
  so none can change the run's own objects. Nothing in the repository stores or sends items yet.

## Running tasks

Immediately before each model call, after summaries and model-input hooks, the loop reads
`TaskRegistry.runningTasks` for the calling session. A `running-tasks` notice contains the current
running tasks, including services, but no settled tasks, command strings or output. It is absent
when there is no visible running work. Generic tasks are visible; tasks owned by other sessions
are not. A task that finishes during a call disappears from the next snapshot, independently of
when its group's completion notice is delivered.

The snapshot keeps the 10 most recent tasks by start time, with later registration breaking a tie.
It reports `total` and `omitted`, so a large registry never silently loses the remaining count.
Each entry carries `id`, a launch `title` (at most 200 characters), `reason` (at most 1,000),
`startedAt` in epoch milliseconds, and optional `group`, the first requested member's task ID.
Long titles and reasons end in an ellipsis within their limit. Reasons use the stored wait reason
when the entire group is compatible with the caller, otherwise the launch description. If any
member is owned by another session, the shared group reference and reason are hidden; compatible
tasks remain visible. Membership still controls completion delivery as before.

The model receives the notice beside `messages`, after context and recovery notices. The same
payload is emitted through the ordered `harness_notice` event and session stream. Providers use
core's formatter to frame titles and reasons as data, never instructions or a person's prompt.
No notice is appended to history, `done.messages`, hook messages, or summarizer input. Since each
snapshot comes from the registry, a summary between a task's start and finish cannot hide its
purpose from the next model call. Retries and output continuations rebuild the snapshot too.

Changing or removing this transient notice can invalidate Anthropic signed-thinking replay,
although system instructions and retained history remain unchanged. See
[provider replay costs](../../providers/docs/prompt-caching.md).

## Output-limit recovery

Output truncation automatically continues the original task, with no total continuation cap by
default. A reply that is cut off while keeping no text and no tool call (reasoning alone does not
count, since a provider drops unfinished thinking) is fruitless: asking again repeats the cut-off.
After `MAX_FRUITLESS_CONTINUATIONS` such replies in a row the run ends `max_tokens`; a reply that
keeps text or a tool call, or any normal turn, resets the count.
`maxOutputContinuations` optionally bounds recoveries across the whole run, including truncated
tool turns; zero disables recovery. Recovery never bypasses `maxTurns` or an abort. Partial replies,
reasoning and completed tool results stay in history, and completed tools are not rerun by the loop.
The next request carries a transient `output-continuation` notice asking the model to finish
silently without repeating work. Neither synthetic user messages nor changed system instructions
are needed. Provider-bound reasoning is replayed only when its original prefix still matches.
The same notice is emitted as `harness_notice` before the model call, with its attempt and an
optional explicit maximum. Each UI chooses its own presentation; the terminal shows no interruption.
Exhausting an explicit allowance ends with `max_tokens`, not `completed`.
A reply cut by a lost connection (a provider's `ConnectionLostError`: the body broke, or sent
nothing for minutes, after the reply started) is recovered in the same spirit, by the `dropped`
contribution `continue-after-lost-connection`, but it is not an output-limit recovery and shares
none of its counters: it has a count of its own (at most `MAX_LOST_CONNECTIONS_IN_A_ROW` calls in
a row, however much each kept; a call that completes starts the count again) and never spends
`maxOutputContinuations`. The text and whole tool calls that arrived are kept, the tools the model
already called are left to finish (not stopped as a failed call's are), and the next request
carries an `output-continuation` notice with `reason: 'connection'`, which tells the model its
reply was cut by the connection, not by the token limit. A drop before anything arrived leaves no
empty reply behind and the call is made again, and a reply that kept only reasoning is dropped
too (a provider does not take a reasoning item back with nothing after it). The cut turn ends
with `turn_end` `connection_lost` (not `interrupted`) and does not run `afterTurn` or the limits,
and a later call that waits for the network says so with `model_connection`. Once a bound is
reached the run fails with the `ConnectionLostError`, and every other provider failure still
fails it at once.
Context exhaustion ends with `context_window_exceeded` without
retrying: a larger output budget cannot repair a full context window. Without the `summary`
option the loop does not summarize history or discard messages; with it, see below.

## Summaries

`summary: { summarizer, policy? }` on `streamAgent` makes the loop write a checkpoint when the
context nears the window. Without it the loop writes none, though a checkpoint already in
`messages` is still applied to what the model sees. No package picks a summarizer or a threshold:
the UI passes them.

- **History and view.** The loop keeps `HistoryMessage[]` (`messages` and `done.messages`): the
  conversation plus any `summary` checkpoints, append-only. A model is sent `viewOf(history)`: the
  newest checkpoint rendered as one user message (`formatCheckpoint`, `@sheavly/core`), then the
  user messages it pins (below), the `kept` messages right before it and everything after. A
  provider never sees the `summary` role, and hooks are handed the same view, so they see the
  shortened state.
- **Pinned prompts.** The latest prompt a person typed (the host gives those an `id`) and the
  latest user message of any kind stay word for word in the view even when they are older than
  the kept tail (`pinnedBefore`). This is what lets a run of one prompt and a long tool loop be
  summarized: everything the model did after the prompt becomes the checkpoint while the request
  stays exact. It is a function of stored history, so no field is stored for it. A pinned
  message is not capped or counted against `keepTokens`, as it was not when it sat in the tail:
  a very large pasted prompt stays in every view, and if the view alone fills the window no cut
  can shrink it.
- **When.** After finished tasks and received messages are added, before `beforeTurn`: threshold,
  when less than the free buffer is left (15% of the window by default, so at 85% used; a UI may
  add a minimum in tokens, never more than half of the window; unknown window or usage means no
  summary). Also once per model call when the
  provider rejects the call as too long (`context_window_exceeded`): one summary, then a retry,
  and the run ends `context_window_exceeded` as before if that fails or happens again.
- **The cut.** `chooseCut` keeps about `keepTokens` of the newest messages, never splits a tool
  call from its result. Unless the UI set `keepTokens`, `keepTokensFor` sizes the tail from the
  window and how full the context was, so the context lands between 15% and 50% of the window
  after the summary (aiming at 35% of what it used, less room for the checkpoint and the pinned
  request) and the tail is never empty, even in a conversation of one prompt. It may cut past the latest user message, which the view pins, and finds
  nothing to summarize only when nothing but pinned messages lies before the tail. The
  summarizer is given the newest checkpoint's sections and the messages since its tail began,
  the pinned prompt included, since it needs the request to write the goal, so each pass is small
  and old facts are carried forward. A pinned message is not counted as summarized or replaced
  (`summarized`, and the "smaller than what it replaces" check), because the view still shows it.
- **Events.** `summary_started`, then exactly one `summary_done` or `summary_failed`, through the
  ordered queue. A failure (the summarizer threw, the run aborted, the result was rejected) is
  redacted like `run_failed`, appends nothing and never fails the run; threshold summaries stop
  being tried for the run after `maxFailures` in a row. A summary gets one initial attempt and one
  retry inside the same `summary_started`/`summary_done` pair (a cancelled run is not retried),
  and `summary_failed` carries a `kind`: `generation` (the summarizer or a hook produced nothing
  usable), `preservation` (the result would break the request or tool pairing),
  `size` (not smaller than what it replaces) or `cancellation`.
- **Coverage.** Each checkpoint records `covered` (where its coverage ends, which is where its
  own tail begins) and `incorporated` (the position of the checkpoint it folded in), so
  successive summaries advance from the beginning without skipping or repeating entries. Stored
  history is held to it (`assertValidStoredHistory`): a checkpoint that does not end at its own
  tail, does not fold in exactly the one before it, or covers less than it is refused.
  `incorporated` is absent only on the first checkpoint.
- **No room.** When the context is past the threshold, no summary helped (one failed, was not
  tried again, or there was nothing to summarize) and what a model would be sent is estimated to
  fill the whole window, the run ends `context_window_exceeded` before calling the model, with
  history untouched and valid. If the next request still fits, a failed summary leaves the run
  going on the unchanged view.
- **The request.** A request is a stored `user` entry, found with `latestRequest`
  (`@sheavly/core/history/history.utils`); a notice is its own role in history and only becomes a
  `user` message in what a model is sent, so a notice after the request never fails the check
  that the request is still shown word for word. `harness/no-adhoc-latest-request` keeps other
  code from looking it up by hand.
- **Hooks.** `beforeSummary` runs after `summary_started`, in hook order, and may move the cut
  (`keepTokens`) or add sections (`runBeforeSummary`); its result is parsed, and a bad one (a
  `SummaryHookError`) or a throw (a `HookError`) is reported as `hook_failed`: the hook is skipped
  and the summary is written without it. A hook that ignores its signal is raced against the
  abort, like the summarizer.
  `afterSummary` runs once the checkpoint is appended and `summary_done` is emitted
  (`runAfterSummary`, handing each hook copies of the checkpoint and the view), so what it adds
  with `addContext` follows the checkpoint in history, is
  reported as `context_added`, and a throw is reported as `hook_failed` without failing the run.
  It is raced against the abort too, and an
  `addContext` that arrives after the abort adds nothing. See
  [hooks](../../core/docs/hooks.md#around-a-summary).
- **Rejected results.** `SummaryRejectedError` (never thrown to the caller; it is the text of a
  `summary_failed`) when the result has no sections, is not smaller
  than the messages it replaces, or would leave history that breaks the rules
  (`assertValidHistory`).
- **After a checkpoint** the session's last reported tokens are cleared
  (`SessionRegistry.forgetLastTokens`), since they described the replaced history; the next call
  reports its own.

The defaults (`DEFAULT_SUMMARY_POLICY`) are starting points, not measured values. The design and
its evidence are in [docs/summary/design.md](../../../docs/summary/design.md).

## Context usage

Before every model call the loop reads the provider's `contextWindow` and the session's last
reported tokens (`sessions.lastTokens`) once, and uses that one reading three ways:

- **The agent** gets a typed `context-usage` notice in the request's `notices` (`sample.helper.ts`).
  Providers use the [shared formatter](../../core/docs/providers.md#harness-notices) to label it
  as harness telemetry, not user input, and direct the model to use it silently unless context
  limits affect the task. For example, its measurement is `Context: 48,210 of 400,000 tokens used (12%)`.
  "Used" is the last call's input plus its output, what the model saw, not a total over calls.
  The notice changes every turn, so it never goes through `instructions` and is never put in
  history: not in `done`'s messages, not resent next turn. It is a field of its own, not a message
  in `messages`, so the cached prefix is unchanged. A provider whose replay state is bound to what
  a call sent has to account for it: Anthropic binds a thinking signature to the notice too, so
  that thinking is not replayed on the next turn (see the provider contract). It shrinks to what
  is known: the window alone before any usage is known, the used tokens alone when the window is
  unknown, nothing when neither is.
- **Hooks** get the same numbers as `beforeTurn`'s and `beforeModelCall`'s `context` (`window`,
  `used`), so a hook that hides old output decides from what the agent sees.
- **A UI** gets the window on the call's `usage` event (`usage.contextWindow`) next to its tokens,
  emitted after the turn's stream and before `turn_end`. The harness renders nothing itself: the
  line is for the model, and a UI shows usage however it likes from the event.

Before calling the provider, the loop also emits `harness_notice` with the exact notice payload
sent on that request. It uses the ordinary ordered event queue and combined session stream, so
downstream UIs receive structured data with session attribution and replay support, not formatter
text. When neither context count is known, no context notice is sent; recovery notices are independent. Model history and
system instructions still contain neither the notice nor its UI event.

The numbers belong to the session, so a sub-agent has its own against its own provider's window,
and a conversation's next prompt carries on from the last call. A call that reported no usage
clears them, since stale ones would say the context is emptier than it is. After a model switch
the count is the previous model's measure of the same history, paired with the new window until
the next call reports its own.

## The turn as a state machine

A turn is a fixed sequence of phases; each phase that holds features is a list of contributions.
The phases in bold are lists; the others are one step each (the hooks and the model call, which
have their own failure path).

| Phase | What happens                                                                                      | Failure / abort                                |
| ----- | ------------------------------------------------------------------------------------------------- | ---------------------------------------------- |
| 1     | abort check                                                                                       | `interrupted`                                  |
| 2     | **`delivery` contributions**: steering, finished work, `hook-failed` notices, then hooks          | contribution policy; delivery hooks raced      |
| 3     | **`room` contributions**: the threshold summary (`full` ends `context_window_exceeded`)           | contribution policy; `summary_failed` events   |
| 4     | `beforeTurn` hooks                                                                                | reported, skipped; raced                       |
| 5     | **`view` contributions** (masking), then `beforeModelCall` hooks                                  | contribution policy; hooks reported, skipped   |
| 6     | model call, tools start as they stream                                                            | provider failure fails the run                 |
| 7     | **`overflow` contributions** (summarize and retry), **`dropped`** (go on after a lost connection) | contribution policy                            |
| 8     | reply and tool results into history                                                               | none                                           |
| 9     | `afterTurn` hooks                                                                                 | reported, skipped; raced                       |
| 10    | **`limit` contributions**: window exceeded, then output-limit recovery                            | contribution policy                            |
| 11    | **`completion` contributions**: running tools, inbox, yield, `await_tasks`, settled               | contribution policy; abort gives `interrupted` |

`delivery` is in this order because finished work and failures must be in history before any hook
sees them: `steering-messages`, `finished-tasks`, `hook-failures`, `extension-notices`,
`delivery-hooks`. `extension-notices` drains the session's outbox (the notices extensions queued
with `emit.notice`) through `publishNotice`, so the stream event and the history entry carry the
same payload in order; a failed drain is reported like a failed hook and the run goes on, and
`notice` hooks are never offered an `extension-notice`, as they are not a `hook-failed`. `completion`
is in the flow rules' order (the guide's rules 1 to 5): a yield outranks task completions but not
`await_tasks`, and the last contribution, `settled`, always answers. The existing flow-rule tests
pin that order. The run around the turns: `sessionStart`, the turns, `sessionEnd`, then `done`
(always last).

A **contribution** (`contributions.types.ts`) has a `name`, an optional `after` (ordering), an
`onFailure` (`fail-run`, or `report`: skip it and report like a failed hook) and an `abort`
(`race`: stop waiting when the run aborts, or `wait`). `buildContributions(options)` builds the
lists once per run, orders them (a duplicate name, an unknown `after` or a cycle throws a
`ContributionError` before the first model call) and is the one place that decides which features
exist: masking and overflow recovery are absent without a `summary` option, and `runTurn` never
tests an option. To add a feature to a phase, add one entry to that phase's list in
`turn-contributions.helper.ts` and a test in `contributions.test.ts`.

## Tool names

When a run starts, the loop reads `options.tools` once and checks that list: two tools sharing a
name, compared exactly, throw a `DuplicateToolError` naming the tool, before any `sessionStart`
hook or model call and through the same failure path as a miswired hook (`onError` hooks,
`run_failed`, one `done`). The list is copied and frozen, and the run goes on with that copy, so
code that later changes the array it passed changes nothing the run sends or runs. The tool
objects are not frozen. A sub-agent's run starts the same way, so a parent tool that shares a name
with what the sub-agent adds (`report_status`, the task tools, `start_agent`, `message_agent`,
where its depth gives it them) fails it. See [tool names](../../core/docs/tools.md#the-contract).

## Hook order

- Hooks run in the order given, unless one names hooks it must come `after`: the loop orders the
  list once when the run starts (the same ordering the turn contributions use) and every runner
  reads that list. A duplicate hook name, an `after` naming a hook the run does not have, or a
  cycle throws a `ContributionError` before the first model call.
- Every handler runs one after another, except `aroundToolCall`,
  which nests: the first hook is outermost. It calls `next()` to continue, `next(input)` to
  change the input (validated as usual), or returns a result without calling it to block.
  The result is `{ content, isError, artifacts? }`: `content` goes into history, `artifacts`
  (what the tool returned for a UI, see [artifacts](../../core/docs/tools.md#artifacts)) go only onto the
  `tool_result` event, so a hook can drop, replace or add some without the model seeing them.
- `beforeModelCall` hooks chain: each gets a deep copy of the previous result, and the last result
  is what the model call sends. The run's stored history is not that array and is never changed
  by it; the turn goes on appending the reply and tool results to the history. Each result is
  parsed as a list of messages and goes through `assertValidHistory` (`history/`), so something
  that is not messages, a broken pairing, an empty list, or a dropped or changed latest user
  message is an `InvalidHistoryError` naming the hook: the hook is skipped, reported (see
  below) and the model is sent the messages from before it. A hook that returns its input
  unchanged is not checked. An abort while a hook runs ends the run `interrupted`. A hook whose result added, dropped or edited messages emits
  `model_input_changed` (`{ hook, turn, added, removed, edited }`) through the ordered queue,
  after the turn's `context_added` events and before the model streams. A hook that returns what
  it was given emits nothing.
- **One failure path.** Every handler runs through `guarded` (`hooks/guarded.helper.ts`): raced
  against the abort, so a hook that ignores its signal cannot hold the run. A handler that
  throws is skipped and reported: a `hook_failed` event (`{ hook, handler, error }`, redacted)
  at once, and a persistent `hook-failed` notice the model sees at its next call, once per hook
  and handler (later failures arrive as a `repeats` count). The run goes on without that hook's
  contribution (instructions it added before throwing are dropped). An abort is not a failure
  and is not reported. `onError` handlers run after an abort too. `sessionEnd` likewise.
- Fail closed: `aroundToolCall` turns a throw into an error result, and an `approval` hook that
  throws skips the command with the reason, so a broken guard never lets a call through.
- New points: `taskCompleted` (finished work delivered) and `notice` (a persistent notice in
  history; never a `hook-failed` one) may `addContext`; `sessionEnd` runs once before `done`;
  `approval` screens the run's own session's requests on `options.approvals` before a UI hears
  of them (`ApprovalRegistry.screen`), the first answer winning.
- A sub-agent run gets only the hooks its parent passes it, and runs its own `sessionStart`.

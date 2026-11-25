# The provider contract

What a model backend implements (`@sheavly/core/provider/`). The built-in backends and how to add one are in [@sheavly/providers](../../providers/docs/backends.md).

## The request

A provider (`packages/core/src/provider/`) is one method, `stream(request)`, returning
`StreamEvent`s. Every model call gets a fresh `ProviderRequest`:

| Field          | What it is                                                                                                                                                 |
| -------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `instructions` | System instructions for this call, or none: the run's `instructions` option, then what `beforeTurn` hooks added (e.g. AGENTS.md), joined with blank lines  |
| `messages`     | The conversation history (a copy): user, assistant and tool messages                                                                                       |
| `notices`      | An optional ordered array of typed `HarnessNotice` values: transient harness data sent after history, never part of it                                     |
| `temperature`  | An optional sampling hint for repeatable work (a summary). An adapter sends it only where its API accepts it with the call's other settings, else omits it |
| `cacheKey`     | An optional opaque session identifier an adapter maps to its backend's cache routing key, or ignores when it has none                                      |
| `tools`        | The tool definitions (name, description, JSON schema)                                                                                                      |
| `signal`       | Aborts the call                                                                                                                                            |

`instructions` are rebuilt each turn and never stored in `messages`, so they can change between
turns (an edited AGENTS.md) without touching history. The Responses client sends them as the
API's `instructions` field.

## Connection reports

A provider that cannot reach its backend says so on the stream with `model_connection`
(`ModelConnection`, `@sheavly/protocol/connection/connection.types`) and goes on waiting or
retrying instead of failing the call: `offline` (this machine has no connection), `provider_unreachable`
(the connection works and the provider does not answer; a retry count is attached) and `restored`
once the call got through. They come before any text of the reply, repeat nothing already said, and are never
kept in history. A provider that never waits sends none. How the built-in backends decide is in
[@sheavly/providers](../../providers/docs/backends.md).

## Harness notices

`HarnessNotice` (`@sheavly/protocol/notice/notice.types`) separates transient harness data from user
input and standing instructions. Its first kind, `context-usage`, carries validated context
counts with at least one of `window` or `used` known. Unknown counts are omitted, not zero.

`output-continuation` carries the recovery `attempt` and an optional explicitly configured
`maxAttempts`. Its formatter asks the model to finish the original task without repeating completed
text or tool actions, and without acknowledging the notice or cutoff. Multiple notices can coexist
on a request, so recovery does not replace context telemetry.
Provider implementations consume `request.notices` as an ordered array, rather than a single
`request.notice`; model and UI payloads still use the same `HarnessNotice` type.

Providers use `formatHarnessNotice` (`@sheavly/core/notice/notice.utils`) for consistent wording:
an explicit `<harness-notice kind="context-usage">` envelope identifies telemetry as not a user
message or request and tells the model to use it silently unless context limits affect the task.
The formatter owns this handling policy; callers supply data, not free-form instructions.
Its static wording lives in the internal `notice/notice.constants.ts`; the formatter inserts
the current context measurement without changing the policy text.
The loop emits the same data as a `harness_notice` event before the model call. UIs receive it
through the ordinary session stream without provider imports, text parsing or a special route.
They decide whether and how to render it; model-facing wording and UI presentation stay separate.

Those two kinds are transient: they travel in `request.notices` and are never stored. Persistent
kinds (`agent-report`, `task-finished`, `tasks-finished`) are facts the model must remember, so they are stored in
history as a `notice` entry, and the loop shows them to the model as a user-role message holding
`formatHarnessNotice`'s text. That message has no `id`, so it is never taken for a prompt. A
sub-agent's report is inserted whole between fixed lines with only its angle brackets swapped, so
it cannot close the envelope. The envelope is written only in core
(`harness/no-handwritten-notice`).

A `tasks-finished` group formats its nonempty ordered list using the same individual notice bodies
inside exactly one trusted outer envelope. Its wait reason is explicitly attributed to the calling
agent as agent-authored DATA, not an instruction. Reason, command, report and output payloads have
angle brackets escaped; data fences outgrow dash runs in their payloads. Reports remain unbounded,
while task output retains the supplied bounded preview. The summary model-view path also projects
stored notices through this formatter, so retained groups use the same trust boundary after a
checkpoint and when estimating or summarizing history.

`notices` are not history, so an adapter appends their formatted text after it has built the history.
The API may require a user-role message; the envelope distinguishes its actual origin. Each
turn's notice is gone from the next request, which matters to replay state bound to
what a call sent: Anthropic binds a thinking signature to everything before the reply, the notice
included, and refuses the block (400) once that content is missing. Its adapter therefore treats
the notice as part of the reply's prefix and drops that thinking on the next turn, instead of
replaying it. Responses and Chat Completions have no such binding.

## Prompt caching

Every turn resends nearly the same prompt, and backends reuse the work done on a prefix that is
byte-identical to an earlier call. The prefix is, in order, `instructions`, `tools` and the
`messages`; `notices` come after it and change every turn, so they are never part of it. An adapter
for any backend follows these rules, whatever its way of caching:

- **Keep the order and bytes stable.** Serialize instructions, tools and earlier messages the
  same way on every call. Put per-call data (`notices`, anything that changes each turn) after
  the last stable message, as its own trailing part: never inside a message that the next call
  sends without it, since that changes bytes the backend would otherwise reuse.
- **Map `cacheKey` if the backend has an equivalent**, and ignore it otherwise. It names the
  session; it never carries a choice of what to cache.
- **Opt in where the backend requires it** (a request field or a marker), with an adapter option
  to turn it off for a deployment that rejects it.
- **Report what the backend says it reused** in the call's `usage` (cache read and write tokens),
  so a run can check that caching works instead of assuming it.

Caching that needs more than this, such as a checkpoint marker the backend wants at a chosen
position or a cache object that is created and referenced by name, belongs in the contract only
once an adapter needs it; the research in
[@sheavly/providers' prompt-caching.md](../../providers/docs/prompt-caching.md) says which do.

## The context window

A provider may expose `contextWindow`, the size of its model's context in tokens. The loop reads
it before each model call, so a provider that can change model answers for the one its next call
goes to. A provider that doesn't know it leaves it out, and the run goes on without it.

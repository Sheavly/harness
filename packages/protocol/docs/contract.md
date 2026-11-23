# The wire contract

What is in the contract, what stays out, and how it is kept honest.

The stream, session and task shapes below are the wire as it is built today. The model that
replaces them (nodes, channels and one subscribe endpoint) is decided and written in
[the wire model](wire-model.md). Its schemas are in the contract and described in
[The wire model's schemas](#the-wire-models-schemas); nothing serves them yet.

## What is in it

`@sheavly/protocol` is the bottom layer: everything the harness sends a UI or accepts from one
(`AgentEvent`, `SessionUpdate`, `StreamEntry`, `ApprovalUpdate`, `ApprovalResponse` and the types inside them),
defined once as zod schemas. Every type is `z.infer` of its schema, so the TypeScript types and
what goes over the wire can't drift. It depends on zod only: its `package.json` lists no
workspace package, and the layout check holds it to that.

- A TypeScript UI imports the types (`@sheavly/protocol/event/event.types`) and can parse what it
  receives with the schemas (`event.validator`).
- Any other client reads `packages/protocol/contract.schema.json`, the whole contract as one JSON
  Schema (draft 2020-12, every type under `$defs`). `npm run schema -w @sheavly/protocol` writes it
  from the schemas, and a test fails when the committed file is out of date.
- A loop test (`wire-contract.test.ts`) parses every event and session update of a scripted run
  against its schema.
- Ids are branded: `SessionId`, `CallId`, `TaskId` and `ApprovalId` (each `<x>IdSchema`, a
  `z.string().brand<…>()`), so one kind can't be passed where another goes. The brand is
  type-only, so on the wire and in `contract.schema.json` each is a plain string, named under
  `$defs`. A value gets its brand by being parsed (a TypeScript UI parses what it receives, or
  `sessionIdSchema.parse(id)`), never by `as` (`harness/branded-ids`, `harness/no-brand-cast`).
- An event inside a `StreamEntry` is an `EntryEvent`: the same as an `AgentEvent`, except that
  its `done` has no `messages`. The combined stream is kept for replay, so the history isn't in
  it; a UI reads the history on its own.
- Only the wire contract lives there. What a provider streams (`StreamEvent`, `StopReason`) and
  the code contracts (`Tool`, `Hook`, `Adapter`) stay in `@sheavly/core`, and the queue's generic
  `Sequenced<T>` in the loop.

## The wire model's schemas

The schemas of [the wire model](wire-model.md) are in the contract beside the stream's, and
nothing reads them yet: no route serves them, no registry produces them and no store keeps them.
They are in `contract.schema.json` by name (`NodeInfo`, `Cursor`, `ChannelBoundary`, `ChannelLog`,
`TreeChannelEntry`, `TreeSnapshot`, `SubscribeRequest`, `MessageNodeRequest`, `PromptSent`).
JSON Schema cannot say what a refinement says, so a client that is not TypeScript reads the
shapes, patterns and caps from it and takes the rest from the zod schemas and this page: the
state, end and outcome of a node agreeing; a snapshot's links; a request's duplicates, `snapshot`
and `approvals` rules and its caps by channel; and the reserved extension names.

- **A node** (`node/`, `NodeInfo`): one unit of work, a union by `kind`. `agent`, `command` and
  `service` are built in; a kind an extension adds is `<extension>.<name>` and carries a versioned
  `data` (at most `MAX_EXTENSION_DATA_BYTES`) and a plain-text `text` fallback, so a reader that
  does not know the kind still shows it; a node kind cannot name `agent`, `command`, `service`
  or `tree` as its extension (the manifest does not refuse those names yet). The common fields are
  an id (lowercase, and never `tree`), a parent, a title, a state, a status text, times and the
  tool call that spawned it. A title and a status text are one line of plain text with a cap,
  refusing what the terminal escapes, newline and tab included, and text that draws as nothing;
  a look-alike title is accepted, so a title is never an identity. A command's or service's
  `command`, `description`, reason, `output` (the runtime's preview size, held equal by a test
  there) and error each have a cap, as `data` and `text` do, and whoever builds a node's body for
  the wire shortens a longer one (the node registry holds a node's title and status, and shortens
  those). Its state is one of the `node` machine in `STATUS_TABLE`:
  `running`, `idle` (an agent only), `completed`, `failed`, `cancelled` and `lost`. The node is not
  its own parent, and its state, end time and an agent's last outcome agree; an outcome becomes a
  state by `NODE_STATE_OF_OUTCOME`: `interrupted` is `cancelled`, and the three limits are
  `failed`.
- **A channel** (`channel/`): the entries of one node's channel, and the conversation's `tree`
  channel, in one envelope of `channel`, `cursor`, `at` and `type`. A cursor is opaque text: `s`
  and a position for a channel that numbers its entries, `b` and a byte offset for the output of
  a command or a service, at most fifteen digits. A channel starts with an `opened` entry and ends
  with a `closed` one; `channelLogSchema` checks that the entries of one channel have that shape
  (opened first, closed once and last, one cursor kind, no gap in a sequence, no step back in
  bytes). The log is not bounded: it has no length cap, its entries keep any extra field, and only
  a type name is capped, so whoever feeds it bounds the input. What an entry of another type holds
  is the schema of the issue that serves it.
- **The tree channel** (`tree/`): its entries are numbered. `node_opened`, `node_updated` and
  `node_closed` carry a node; `approval_requested`, `approval_resolved` and `approval_cancelled`
  carry the node that asked; the queue's changes, a storage failure and an extension's event are
  the conversation's own. `prompt_started` carries the user message it became. A snapshot is
  every node (an ended one included) and every waiting approval, with the cursor to continue
  from, and refuses a node twice, a parent that is not in it, parents in a circle, an approval
  twice or from a node that is not in it, and more than `MAX_TREE_NODES` nodes or as many
  approvals (the node registry refuses a node past the first bound, and the approval registry a
  request past the second). A
  snapshot at its bounds is still a large document, which the route that serves it bounds.
- **A subscription** (`subscription/`, `SubscribeRequest`): `{ subscriptions: [{ channel, from }],
approvals? }`. `from` is `start`, `now`, `snapshot` (the tree channel only), `tail:<n>` or a
  cursor. The request holds at most `MAX_SUBSCRIPTIONS` channels, none twice, a `tail` of at most
  `MAX_TAIL_BYTES` (the output store's read bound) and at most `MAX_TAIL` entries on the tree
  channel, and `approvals` only with the tree channel. A cursor the log cannot start at is
  `cursor_out_of_range`, which only the server can tell.
- **A command** (`node-command/`): `MessageNodeRequest` is the text sent to an agent node, whose
  sender is the caller. `PromptSent` is the answer to a prompt sent: the node that carries the run
  and, for a prompt that started, the id of its user message. A command to a node that ended is
  `node_ended`. Cancelling a node has no body and no answer.

The agent channel's entries and a command's output entries are not here: the issues that serve
them define them.

## Version

There is one version: the `version` field of `@sheavly/protocol`'s `package.json`, a semantic
version (`major.minor.patch`, optionally `-prerelease`, never `+build`). It is the protocol
version (`PROTOCOL_VERSION`), `contractVersion` (a string) in `contract.schema.json` and
`info.version` in `openapi.json`. Every number, a numeric prerelease identifier included, is at
most 2^53-1 (a larger one would lose precision when compared), and the generated schemas of
`ProtocolVersion` and `ServerVersion` carry the shape as a `pattern`.

- **Compatible** means the same breaking line: the same major from 1.0.0, the same major and
  minor while the major is 0. Any patch is compatible, and a prerelease identifier does not change
  the line. `isCompatible` says it; `checkProtocolVersion` names both versions, says which side is
  older by semver precedence (a prerelease is lower than its release) and gives one action:
  update and restart the server, or update this client.
- **A wire-breaking change is a major bump** (a minor bump while below 1.0.0), written in its
  changeset: a change a client or server of the previous version, or a stored conversation,
  cannot read. Adding an optional field is not breaking. Nothing yet checks that a breaking change
  was bumped as one; the changeset is where it is said.
- **How the code gets it.** `src/version/protocol-version.constants.ts` is generated. Running
  `npm run schema -w @sheavly/protocol` writes it from `package.json` together with the two JSON
  files, so nothing reads a file at run time and it works in a browser. Never edit it, and rerun
  the command after `changeset version`. A test fails when the constant, `contractVersion` or `info.version`
  differs from `package.json`.
- **The server reports it.** `GET /health` answers `{ status: 'ok', serverVersion,
protocolVersion }` and `QUERY /handshake` answers `{ protocolVersion, proof }`, both without a
  token (see "The handshake proof" below). `serverVersion` is the backend's own package version,
  a different number from the protocol's. No client code compares the versions yet.

The harness reads only data written under the current contract: a field is optional only when
absence means something (the first checkpoint's `incorporated`, an ungrouped task's `reason`, a
message a caller wrote without `at`), never so that older data still parses. A field that stopped
being optional drops the data that lacks it, with no compatibility reader;
`required-fields.test.ts` pins the fields that were once optional.

**The wire model is a wire-breaking change** ([wire-model.md](wire-model.md), decided in #438).
It replaces the combined stream, the session and task updates, `QUERY .../stream` with
`Last-Event-ID`, and how a task is addressed, so a client or server of the previous version cannot
read it and a stored conversation's stream does not parse under it. It lands over many pull
requests (#422 to #437), so it is marked here once, not in each. The schemas came with #422,
which took the version bump: `0.0.0` to `0.1.0`, a minor bump because the protocol is below
1.0.0. A server and a client from before it are not compatible (the minor differs), so each
refuses the other until the older side is updated and restarted. Nothing the harness runs reads
the new schemas yet and the old shapes stay until the cleanup (#436): the bump marks the break
the model makes, which the issues that follow complete. The protocol is not frozen until the
model is built (decision 9 of #438), and nothing is published. There is no compatibility reader,
as above: a one-time migration of a stored conversation, when it is first opened (#437), is not
one. This repository has no `.changeset` yet; when it has, the change is written in its
changeset. Every workspace that depends on the protocol names the new version (`^0.1.0`), since a
caret range on `0.0.x` matches only that one version.

## The handshake proof

`handshakeProof({ token, nonce, instanceId, protocolVersion })` proves, without sending the
token, that a server holds it and is a given instance. It is HMAC-SHA256 keyed with the token's
UTF-8 bytes (WebCrypto, no `node:crypto`), as unpadded base64url (43 characters), over

```
u32be(len(nonce)) ‖ nonce ‖ u32be(len(instanceId)) ‖ instanceId ‖ u32be(len(version)) ‖ version
```

Every field is UTF-8 and the length is its byte length, so one field can't run into the next; the
version is the semver string. `verifyHandshakeProof` compares with `crypto.subtle.verify`, never
`===`. A nonce is unpadded base64url of 22 to 86 characters and `newNonce()` makes one of 43 (32
random bytes); a client uses a fresh nonce for every verification. An instance id is 43 characters
of unpadded base64url. The proof holds neither the token nor the instance id. Test vector: token
`correct horse battery staple 0123456789`, nonce `bm9uY2Utbm9uY2Utbm9uY2U`, instance id
`BwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwc` (32 bytes of 7) and version `1.2.3` give
`Gzh_iELlcEtc-sPEPch9JIe8tn02F4_W_kqRpbUFAz0`. The functions do no I/O: the caller validates the
fields (no empty or oversized field) first. An empty token is the one input they check
themselves: both throw `HandshakeTokenError` (an empty key is no secret). A proof is accepted
only in its canonical encoding (the last character's unused bits are zero), so a proof has
exactly one text.

`QUERY /handshake` takes `{ nonce }` (the nonce goes in the body, so it stays out of URLs and
logs) and answers `{ protocolVersion, proof }`; a nonce outside the bounds above is a `400` that
does not repeat it. The server keeps no state for it: it answers any valid nonce, so a client
that reuses a nonce can be replayed. The instance id is made once per server start, is returned by
no route, and also keeps the proof from being a way to guess the token offline, but only while the
instance id stays unleaked: whoever learns it can test guesses of a weak token against a recorded
nonce and proof. A strong random token is the defence that does not depend on the id.

## The discovery file

`discovery/` defines the file a running server writes so a client on the same machine can find it:
`{ formatVersion, url, token, instanceId, pid, serverVersion, protocolVersion }`, in a file named
`DISCOVERY_FILE_NAME` (`server.json`) that a reader takes at most `DISCOVERY_MAX_BYTES` (4096) of.
It is a contract between the server that writes it and the clients that read it, not an HTTP
route: it is not in `API_ROUTES`, `contract.schema.json` or `openapi.json`. `discoveryFileSchema` is
strict. The URL is `http:` or `https:` with no login in it, at most 2048 characters, and the token
is 32 to 512 characters, both plain visible ASCII with no `"` or `\` (checked on the text as
written, so a tab or a space is refused and never quietly dropped), and each version is at most
64 characters, so a valid file always fits the reader's cap. A loopback host is not required.
`formatVersion` (`DISCOVERY_FORMAT_VERSION`, 1) is
the layout of this file and changes on its own, apart from the protocol version.
`peekFormatVersion` reads only that number, so a reader can tell a newer format
(`{ status: 'newer', formatVersion }`) from a broken file (`unreadable`) before validating in full.
Validation errors name fields, never values, so the token does not reach a log through them.

The backend writes the file when it is always on; no client reads it yet. This module only defines it.

## Tool results arrive as tools finish

`tool_call_started` comes when the model asks for a call, so a UI can show every call of a turn
at once. `tool_batch` then lists the turn's calls in the order the model made them. Each call's
`tool_result` (or `task_running`) is released only after the turn ended, in the order the tools
finished: a result that finished while the model still streamed is released first, in the order
those finished, and the rest follow as they finish. It is **not** call order, so always match a
result to its call by `call.id`, and fill in a call's row when its result comes. A UI that cannot
update lines it already wrote (a terminal) can hold a call's title until its result. The history
(`done.messages`, `GET /messages`) keeps the results in call order, which is what the model is
sent next. `event-order.test.ts` and `parallel.test.ts` in the loop pin both orders.

## Reasoning activity

`reasoning_activity` (`{ active: boolean }`) says live that the model started or stopped
reasoning, as its provider could observe it. It is separate from `reasoning`, which carries
opaque replay state late and stays in history. The activity event carries no reasoning content
(its schema is strict, so an extra field is rejected), is never stored in history, and arrives
only as transitions. A provider that cannot observe reasoning sends none, so a UI keeps its
generic busy state rather than claiming the model thinks.

## Run state

`run_state` (`{ state: 'working' | 'waiting', groupedTasks: number }`) says live whether the run
is working (the model generates or a tool runs) or held open after its turn for tasks. `waiting`
carries how many running tasks grouped with `await_tasks` it still waits on; with 0, only
ungrouped tasks or services remain and the run is ready for a follow-up, which is queued. A
follow-up queued while `waiting` has grouped tasks stays queued while they run, and starts as the next prompt once the model has finished.
It is sent on every change and never stored in history, so the newest one
is the current state, and a UI of a sub-agent's session reads that session's own. A hold can end
with no closing `working` (the run was aborted or yielded, or only services remain), so `done`
ends the state: a UI treats the run as over when it arrives.

## Storage failure

`storage_failed` (`{ error: string }`) says live that the conversation could not be stored: a
stream, history or index write failed. It is sent once when writes start failing (not per write, and
not for a retry that fails again), under the main session, and again only after storage was healthy
in between. It never ends a run: the prompt carries on, and the conversation refuses its next
prompt with `storage_failed` unless a retry (`recover`) has stored what was lost. `error` names the
file or conversation and never what it holds. It is not history and not model input. A UI shows it
and does not treat the run as over: `done` still ends the run.

## Harness notices

`HarnessNotice` (`@sheavly/protocol/notice/notice.types`) is defined by `harnessNoticeSchema` in
the same module's validator. A `harness_notice` event carries it before the model call; the loop
and combined session stream expose the same payload, including session attribution and sequence
order. It is also named in the generated JSON Schema and OpenAPI documents for non-TypeScript UIs.

The first kind, `context-usage`, carries `context.window` and/or `context.used`. At least one
count must be known. Used tokens are nonnegative whole numbers; the window is a positive whole
number within the model contract's bound. Zero usage and usage exceeding capacity are valid.

`output-continuation` carries a positive integer `attempt` and optional positive integer
`maxAttempts`. An absent maximum means recovery is not capped by a continuation allowance.
Context and recovery notices each have their own ordered `harness_notice` event before the call.
There is no separate continuation event: a stream holding the old `output_continuation` entry no longer parses.

`running-tasks` carries a bounded live snapshot: `{ kind: 'running-tasks', tasks, total, omitted }`.
Each task is `{ id: TaskId, title, reason, startedAt, group?: TaskId }`; `startedAt` is epoch
milliseconds and `reason` is calling-agent-authored data. `group` is a scalar stable identifier:
the first member ID requested when forming the delivery group, not an array of member IDs. Runtime
supplies it; the first member need not be present in this bounded snapshot.

The literal limits in `notice/notice.constants.ts` are `MAX_RUNNING_TASKS` (10),
`MAX_RUNNING_TASK_TITLE_CHARS` (200) and `MAX_RUNNING_TASK_REASON_CHARS` (1000). The task array
must be nonempty. Empty titles and reasons remain valid, matching existing registry text semantics;
IDs retain the existing `TaskId` brand semantics. Titles and reasons are bounded in JavaScript
string characters (UTF-16 code units). `total` and `omitted` are nonnegative integers, and parsing rejects
`total !== tasks.length + omitted`. Task entries and the snapshot reject unknown fields, including
commands and output. `RunningTask` and `RunningTasksNotice` are inferred protocol types. The count
equality is enforced by zod parsing; standard generated JSON Schema describes the field bounds
but cannot express this cross-field arithmetic invariant.

Every kind has a lifetime, declared once in `NOTICE_LIFETIMES` (`notice/notice.constants.ts`); the
formatter, history, the loop and the stream read it through `isPersistentNotice` and
`noticeLifetime`, never by listing kinds. Adding a kind is its schema plus one registry entry
(typecheck fails without it, and `NOTICE_SAMPLES` in `@sheavly/testing` needs a sample, which runs
the new kind through the formatter, history and stream tests). The three above are **transient**: sent beside the history on one model
call and never stored, because context and running-task snapshots become stale on the next call
and a continuation's partial reply is already in history. **Persistent** kinds are facts the model has to remember, so
they are also stored in history as a `notice` entry (`NoticeMessage`, in `history/`: `{ role:
'notice', notice, at }`), and the same payload is carried by the `harness_notice` event. A UI can
read it from either and decides whether and how to show it.

- `agent-report`: a sub-agent finished. `agent` is its `AgentInfo` snapshot (id, title, parent,
  root, depth, model, last reported status, times), `taskId` the background task it ran as,
  `outcome` how it ended (`RunOutcome`) and `report` what it wrote, whole and unbounded.
- `task-finished`: a background task finished. `task` is its `TaskInfo`, whose `output` is still
  the bounded preview.
- `tasks-finished`: one completion delivery, with an agent-authored `reason` string and a nonempty
  ordered `notices` array of `agent-report` and/or `task-finished` snapshots. Nested groups and
  transient notices are rejected. The reason is retained as data, not a model instruction; reports
  remain whole and task outputs remain the existing bounded previews.

All three completion kinds carry `context: TaskCompletionContext`, defined by
`taskCompletionContextSchema` in `notice/notice.validator.ts` and inferred in `notice/notice.types.ts`:

- `reason`: the completion's reason as data, not instructions.
- `startedAt`: epoch milliseconds, using `timestampSchema`.
- `durationMs`: nonnegative elapsed milliseconds (not restricted to whole numbers).
- `userMessagesSinceStart`: a nonnegative integer count of user messages since launch.
- Optional `callId`: the originating tool call, when known.

The `context` field is required on all three: the loop supplies it on every individual notice
and every group, and a report written when a conversation is reopened carries one too. Each
member of a group retains its own context alongside the group's. `TaskInfo.reason` separately
retains the explicit `await_tasks` reason on every grouped task, including tasks that settled
before grouping. It is absent for ungrouped tasks; when there is no explicit wait reason, the loop
uses the task's description for completion context rather than changing the task's launch
semantics.

A persistent notice is a snapshot at the moment it was written. Live state comes from the session
stream, and a UI joins the two by session or task id. `history/` sits above `message/`,
`session/` and `task/` because an entry that carries their data would otherwise make `message/`
import them back.

Notice payloads are structured facts, not model prose, colors, widgets or display directives.
A UI can show a percentage, a warning, its own visualization, or nothing, without parsing an
assistant message or importing provider code. Model handling guidance belongs to the core
formatter, not the wire payload. Adding a notice kind extends this shared schema rather than
introducing a separate model-only or UI-only shape.

## Extension events and notices

An extension's own output is an **open envelope inside the closed union**. `extension_event`
(`{ type, extension, kind, version, data, text }`) is one more member of the event union, and
`extension-notice` (`{ kind, extension, topic, version, data, text }`) one more persistent notice
kind (`NOTICE_LIFETIMES`: persistent, so it is also stored in history and a client cannot send
one). The union stays closed in `type` (the notice's `kind`), but the event's `kind` and the
notice's `topic` are any `<extension>.<name>`, so a reader that does not know one still parses it
and shows `text` (or skips it).

- `extension` is the kebab extension name; `kind`/`topic` must start with `<extension>.`, checked
  by a refinement on the object. `version` is a positive integer, the version of the sender's
  `data` shape.
- `data` is any JSON value (`JsonValue`) that the sender's own schema checked; the protocol does
  not look inside. `text` is a non-empty plain-text fallback.
- Caps, in `extension/extension.constants.ts`: `text` at most `MAX_EXTENSION_TEXT_CHARS` (2000)
  characters, and `data` at most `MAX_EXTENSION_DATA_BYTES` (16384) bytes once serialized as JSON.
- An extension event is live data for a UI, never model input, and is published outside any run
  with its own `seq` 0 (like `storage_failed`). The workbook numbers steps by `seq`, so it shows
  a second `#0` for such an event: a known cosmetic limit (numbering steps by position would fix
  it; that is not part of this change). Only an extension notice's `text` reaches the
  model, through the core formatter as third-party data; `data` never does.
- The extension name and qualified-name patterns are defined here, and `@sheavly/extension`'s
  manifest validator imports them. `extensionEventSchema` and `extensionNoticeSchema` are
  exported so the extension host checks a finished envelope with the schemas the stream and
  history read it with.

## What a server accepts and answers

Model-first setup uses `GET /setup/models` (`ModelCatalogResponse`): backend-provided model
identities and their supported hosting routes, with editable defaults and fixed native-model
fields. The model contract accepts optional `identity: { model, family? }` independently of the
profile UUID, adapter definition and credential. Models without that metadata remain valid.
The protocol defines shapes, not a model catalogue or a choice of provider for a run.

`server/` holds the requests and responses of the harness's HTTP API (the backend's routes, and
`@sheavly/client`'s client for them), so both validate with the same schemas; `api/` lists the
routes themselves (`API_ROUTES`), each with its method, path and these schemas. The `Token`
column says whether the route needs the bearer token: every route does (`bearer`) except those
marked `public: true` (`none`), which only identify the server (`GET /health`,
`QUERY /handshake`). A route is private unless it says `public`, and in `openapi.json` a public
operation carries `security: []`:

<!-- routes:start (generated by `npm run schema -w @sheavly/protocol`; do not edit) -->

| Request                                              | Token  | Body                       | Answer                        |
| ---------------------------------------------------- | ------ | -------------------------- | ----------------------------- |
| `GET /conversations`                                 | bearer | none                       | `ConversationsResponse`       |
| `POST /conversations`                                | bearer | `StartConversationRequest` | `StartConversationResponse`   |
| `GET /conversations/{id}`                            | bearer | none                       | `ConversationDetails`         |
| `DELETE /conversations/{id}`                         | bearer | none                       | nothing (`204`)               |
| `PUT /conversations/{id}/model`                      | bearer | `SwitchModelRequest`       | nothing (`204`)               |
| `GET /conversations/{id}/messages`                   | bearer | none                       | `MessagesResponse`            |
| `QUERY /conversations/{id}/skills`                   | bearer | `SkillsQuery`              | `SkillsResponse`              |
| `POST /conversations/{id}/prompts`                   | bearer | `SendPromptRequest`        | `SendPromptResponse`          |
| `POST /conversations/{id}/yield`                     | bearer | none                       | `YieldPromptResponse`         |
| `GET /conversations/{id}/queue`                      | bearer | none                       | `QueuedPrompts`               |
| `PUT /conversations/{id}/queue`                      | bearer | `QueuedPrompts`            | nothing (`204`)               |
| `POST /conversations/{id}/stop`                      | bearer | none                       | nothing (`204`)               |
| `POST /conversations/{id}/approvals/{approval}`      | bearer | `AnswerApprovalRequest`    | nothing (`204`)               |
| `QUERY /conversations/{id}/stream`                   | bearer | `StreamQuery`              | `StreamEntry`s (SSE)          |
| `QUERY /stored-conversations`                        | bearer | `StoredConversationsQuery` | `StoredConversationsResponse` |
| `POST /stored-conversations/{id}/reopen`             | bearer | none                       | `StartConversationResponse`   |
| `GET /setup`                                         | bearer | none                       | `Setup`                       |
| `GET /adapters`                                      | bearer | none                       | `AdaptersResponse`            |
| `GET /setup/models`                                  | bearer | none                       | `ModelCatalogResponse`        |
| `PUT /terminal-settings`                             | bearer | `TerminalSettings`         | nothing (`204`)               |
| `GET /profiles/{profile}`                            | bearer | none                       | `ProfileSetup`                |
| `PUT /profiles/{profile}`                            | bearer | `PutProfileRequest`        | nothing (`204`)               |
| `DELETE /profiles/{profile}`                         | bearer | none                       | nothing (`204`)               |
| `QUERY /profiles/{profile}/models`                   | bearer | `ModelsQuery`              | `ModelsResponse`              |
| `GET /profiles/{profile}/models/{model}`             | bearer | none                       | `SetupModel`                  |
| `PUT /profiles/{profile}/models/{model}`             | bearer | `PutModelRequest`          | nothing (`204`)               |
| `DELETE /profiles/{profile}/models/{model}`          | bearer | none                       | nothing (`204`)               |
| `PUT /profiles/{profile}/credentials/{model}`        | bearer | `PutCredentialRequest`     | nothing (`204`)               |
| `DELETE /profiles/{profile}/credentials/{model}`     | bearer | none                       | nothing (`204`)               |
| `POST /profiles/{profile}/credentials/{model}/check` | bearer | none                       | `KeyCheck`                    |
| `PUT /default-profile`                               | bearer | `SetDefaultProfileRequest` | nothing (`204`)               |
| `QUERY /workspace-profiles`                          | bearer | `WorkspaceRequest`         | `WorkspaceProfile`            |
| `PUT /workspace-profiles`                            | bearer | `BindWorkspaceRequest`     | nothing (`204`)               |
| `POST /workspace-profiles/unbind`                    | bearer | `WorkspaceRequest`         | nothing (`204`)               |
| `QUERY /trusted-workspaces`                          | bearer | `TrustedWorkspacesQuery`   | `TrustedWorkspacesResponse`   |
| `POST /trusted-workspaces`                           | bearer | `WorkspaceRequest`         | nothing (`204`)               |
| `POST /trusted-workspaces/revoke`                    | bearer | `WorkspaceRequest`         | nothing (`204`)               |
| `QUERY /permissions`                                 | bearer | `WorkspaceRequest`         | `WorkspacePermissions`        |
| `PUT /permissions/mode`                              | bearer | `SetPermissionModeRequest` | nothing (`204`)               |
| `POST /permissions/allow`                            | bearer | `AllowEntryRequest`        | nothing (`204`)               |
| `POST /permissions/revoke`                           | bearer | `AllowEntryRequest`        | nothing (`204`)               |
| `GET /health`                                        | none   | none                       | `HealthResponse`              |
| `QUERY /handshake`                                   | none   | `HandshakeRequest`         | `HandshakeResponse`           |

<!-- routes:end -->

`POST /conversations/:id/yield` has no body and returns JSON `YieldPromptResponse`:
`{ accepted: boolean }`, not SSE. An active run accepts it and ends as `completed` at its next
completion point, without waiting for background tasks or sub-agents; an idle or stopping run
returns `accepted: false`. Nothing is delivered to the run: a client sends further text as the
next prompt. Unknown conversation ids use the ordinary `not_found` error.

- A prompt is `text`, as a script types it (`/<name>` mentions in it run those skills), or
  `parts`, as a UI builds it (exactly the skills picked run). Not both.
- `POST /conversations/:id/prompts` answers at once with `SendPromptResponse`, never with a
  stream: `{ status: 'started' | 'queued', queued }`. A conversation that is busy (a prompt, or a
  run it started itself for finished work) keeps the line in its queue and starts it when that
  run ends, following the flow rules: after the model has finished when the run waits on
  `await_tasks`, otherwise once the model finishes its turn. What the prompt does arrives on the
  conversation's stream (`QUERY /conversations/:id/stream`), which a client follows. Only `text`
  can wait: a `parts` prompt to a busy conversation, a line longer than `MAX_QUEUED_LINE_CHARS`,
  or one that would take the queue past 100 lines or `MAX_QUEUED_CHARS` (100,000 characters
  together) is refused with `cannot_queue`; `PUT /queue` takes the same bounds.
- A `queue` entry on the stream (`QueueUpdate`) carries the whole queue after each change, under
  the main session: `queue_changed` (a line joined, or a client replaced the lines),
  `prompt_started` (the line about to run, before its run's entries) and `prompt_refused` (a line
  that left the queue without starting: its skill is gone, or the conversation can no longer be
  stored). The newest one says what waits.
- A normal prompt's user message keeps `content`, what the model saw (with a skill's
  instructions), and may keep `parts`, what the user typed, for a UI to show the skills as chips.
  Providers send only `content`.
- `origin: 'user'` marks a prompt a person typed, set only by the host's `send`. Context a hook
  added, a sub-agent's task and a message from another agent carry none, so a hook that must act
  on what the user said (the repo's issue registration) reads `origin`, never `id`: a sub-agent's
  task has an `id` but is written by the agent that started it. The host does not check `origin`
  on history a client seeds (`StartConversationRequest.messages`) or on stored history it
  reopens: a client is the user, so what it marks `origin: 'user'` counts as the user's. A client
  must not relay an agent's text that way.
- Every failure is a `ServerError`: `{ error: { code, message } }`, where `code` is one of
  `ServerErrorCode`.

## Who asked

An approval names the session that asked by id only: the stream entry's `sessionId` (also
`ApprovalRequest.sessionId` when a loop ran the tool). A sub-agent's title, depth and parent are
not repeated in the request; they are in its `session_started` update, the one place they are
kept. A UI that wants to show who asked follows the stream from its start (`replay`) and looks
the id up, or uses `watchApprovals` from `@sheavly/client`, which does that and hands back the
sub-agent with each approval. Whether and how to show it is the UI's choice.

## Approval permissions

`ApprovalRequest.options` names the decisions a UI may offer. When it includes `allow_session` or `always_allow`,
the optional `keeps` array carries the exact allow-list entries the choice would save, such as
`touch *`, `git diff *`, `npm run test *` or `npx eslint *`. Each entry uses `allowEntrySchema`. A UI displays those
entries rather than guessing their scope from `command`; requests without `keeps` remain valid.
`{ decision: 'allow_session' }` grants those entries for the current conversation without persistence;
`{ decision: 'always_allow' }` saves them for the workspace. The caller owns applying the grant;
the registry refuses decisions that were not offered, and `approvalResponseOfferedBy(options)`
is the schema a client or server can validate an answer against. A grant covers every option, path and
other argument of its base command, including secret files, outside-workspace access, editing,
execution overrides and npx downloads. Built-in approvals follow the same rule. Different base
commands in a chain are checked independently. `always_ask` ignores every grant.

A grant covers its base command: `sed -n 1,200p src/a.ts` grants `sed *`. An `exact:` JSON array
names a command whose words contain spaces, such as an npm script name; it does not impose exact
argument matching.

## Run limits

`turn_end.stopReason` distinguishes `max_tokens` (output, including thinking) from
`context_window_exceeded` (the conversation no longer fits). Output recovery continues by default
and emits a `harness_notice` of kind `output-continuation` before its next call. If an explicit
continuation allowance is exhausted, the run ends with `max_tokens`; context exhaustion ends with
`context_window_exceeded`. These outcomes appear in `done`, session state and `lastOutcome`, never
`completed`.

## Models

`ModelEffort` is `low`, `medium`, `high` or `extreme`. `ModelSelection` pairs `modelId` with `effort`.
A profile keeps `lastModelSelection` and `modelEfforts`, keyed by model UUID; absent per-model
preferences start on medium. `PUT /conversations/:id/model` accepts optional `effort`: supplying it
sets and remembers effort for that model; omitting it restores that model's last-used effort.
The active model choice, session updates and stored conversation index carry the effort too.
Efforts do not change context size, tool permissions or the output-token limit.

This field was called `mode` before. The API is a clean break: a request that still sends `mode`
has it ignored, like any field the request does not define, so a client must send `effort`. Files a
store wrote with the old names are still read (see the storage design doc).

`model/` is how a model is described to a UI and stored, with no code that talks to a provider:

- A model has an **id**, a lowercase UUID that is the stem of its file (`models/<id>.json`) and
  what a request, a credential and the model switch call it by. A UUID can't name another path, so
  nothing else is accepted as a file name, and the file's own `id` must be its name: a copy or a
  rename by hand is refused, not served under another id.
- It has a **name** for people (`Astra 6`), free text, required because the file name says nothing.
  It is only a label: it is never sent to a provider and nothing is keyed by it, so two models can
  share one, and a UI shows whatever it likes. A model is picked, switched to and stored (a
  conversation's `modelId`) by its id on every route and in every file; where a person types a
  name, the client finds the model by it and sends the id, and asks which when it finds two.
- What the **provider calls the model** is a different thing, one of the adapter's own fields
  (`model` for OpenAI, `deployment` for Azure). `AdapterDescription.remoteField` says which, for an
  adapter that has one, so a UI can show both ("Astra 6", gpt-5) without knowing each adapter's
  vocabulary.
- A model's file (`ModelFile`) is `{ id, name, adapter, ...the adapter's own fields }`: flat, so it
  reads and edits by hand, and complete, so it says what it is whatever it is called. `toModel`
  reads it once into a `Model` (`id`, `name`, `adapter`, `definition`), and `toModelFile` writes
  one back. The file never holds a secret: a key lives with the profile's credentials.
- A model may also carry an optional `contextWindow`, in the envelope like `pricing`: how large a
  context the agent is told it has, so a person can choose it for cost. Every UI offers the same
  two sizes to pick from, `CONTEXT_WINDOW_CHOICES`: "300K" (300,000 tokens) and "1M" (1,000,000),
  rounded, not any provider's exact window. The backend takes any positive size up to
  `MAX_CONTEXT_WINDOW` (10,000,000, a bound against typos), so a host can give a model another
  default or round as it needs; `contextWindowLabel` names a size that is not
  one of the two by its exact count. A model that sets none is told `DEFAULT_CONTEXT_WINDOW`
  (300K). The setting only says what the agent is told: it doesn't limit what the provider
  accepts. A `usage` event repeats the window its call ran against (`ModelUsage.contextWindow`),
  so a UI can show usage against it without looking the model up.
- `AdapterDescription` is what `GET /adapters` says about an adapter: its kind, a description,
  the fields a model of it takes as JSON Schema (a field a person must keep secret carries
  `secret: true`), and the names of the secret fields. A UI builds its form from it, and needs no
  provider code to do so.
- `KeyCheck` is how a check of a model's key ended: `valid`, or `invalid` (the key was refused),
  `not_found` (the endpoint or deployment doesn't exist), `rejected` (the provider answered but
  refused the request) or `unreachable`, with a fixed message, never the provider's own text, so a
  key can't come back in it.

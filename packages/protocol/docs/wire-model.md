# The wire model: nodes, channels and subscriptions

How a front end follows a conversation's agents, commands and services. The decision is
[#438](https://github.com/Sheavly/harness/issues/438); this page is its specification. **None of
it is built yet**: the schemas come with
[#422](https://github.com/Sheavly/harness/issues/422), and the rest of the work is split into the
issues in "What this changes" below. Until then the single combined stream in
[the contract](contract.md) is the wire. The field names here are the decision; the zod schemas
that make them checkable are #422's.

## What exists today

- A conversation has **one combined stream** of `StreamEntry`s with one `seq` for the whole tree
  (`seq` 0, 1, 2, … with no gaps). An entry's `kind` is one of `event` (a loop event), `update` (a
  session update), `approval`, `task` (a task starting or ending) or `queue`. `sessionId` names
  the session the entry is about.
- `QUERY /conversations/{id}/stream` filters it: `session`, `subtree`, `replay` and `approvals`.
  A client resumes with the `Last-Event-ID` header, which is an entry's `seq`.
- A sub-agent is both a **session** (the loop's view) and a **task** (the registry of background
  work), joined only by the tool call id: the task's `callId` equals the session's
  `startedByCall`. A command or service is a task alone. A task is one `TaskInfo` with optional
  fields for the different kinds, and its statuses are `running`, `completed`, `failed` and
  `cancelled`. Nothing records work lost when a server stops.
- No route lists tasks, reads a task's output or cancels one task. A task's complete output is
  kept (`outputLog`, and the output store's byte-ranged `read`), but only a bounded preview
  travels on the stream.
- `POST /conversations/{id}/prompts` already answers at once with `{ status, queued }` and never
  with a stream; what the prompt does arrives on the conversation's stream. (The issue that
  started this design described an older shape, so #429 is narrower than its title.)

What that costs: a front end that wants one sub-agent filters the whole tree's firehose; it cannot
follow a command without reading the disk; two registries describe one thing; and the stored
stream and its replay grow with everything. The protocol is not frozen yet (see "Version" in
[the contract](contract.md#version)), so this is the cheapest moment to change the shape, and
compatibility is not a constraint.

## Vocabulary

- **Node**: one unit of work in a conversation: the main agent, a sub-agent, a command, a service,
  or a kind an extension contributes.
- **Channel**: a node's own append-only log of what happened, in one envelope.
- **Tree channel**: the one channel of a conversation that holds the nodes' lifecycle, the
  pending approvals and the conversation's own notices. A sidebar, a conversations list and a
  notification read only this.
- **Cursor**: a position in one channel. It is opaque to a client, which only stores the last one
  it saw and sends it back.

## Nodes

Every node, of any kind, has the same common fields: an `id`, a `parent` (none for the root), a
`kind`, a `title`, a `state`, its times, and a link to the tool call that spawned it. The parent's
result entry for that call carries the child's node id, since the child does not exist yet when
the call starts, so the two are joined from both sides. Today `task_running` carries a `TaskInfo`
whose task id is a counter, and a sub-agent's session id appears only in the tool's result text, so
carrying the node id in that entry is a change the schema work (#422) makes.

- **Kinds.** `agent`, `command` and `service` are built in. An extension can contribute kinds named
  `<extension>.<name>`. A front end that does not know a kind renders it from the common fields and
  a plain-text `text` fallback. How a kind is declared, registered and rendered is
  [its own specification](../../extension/docs/node-kinds.md) (built in #433).
- **States.** `running`, `idle` (agents only: between prompts, open for the next), and the terminal
  states `completed`, `failed`, `cancelled` and `lost`. The set is the same for every kind: an
  extension cannot add a state, because every front end has to understand state. It can add
  status text.
- **`lost`** is new. When a conversation is reopened, each node that never reached a terminal
  state because the server stopped is closed as `lost` (see "A restart" below).

The lifecycle as a state machine is written in the `sheavly` skill's state-machines guide.

## Channels

Each node has one channel. Every entry has the same envelope:

```
{ channel, cursor, at, type, ... }
```

- `channel` names the node's channel; `at` is when the entry was written (epoch milliseconds,
  like `timestampSchema`); `type` says what the rest of the entry holds.
- **The cursor is defined by the channel**, and a client never builds one. Two kinds exist:
  a gapless sequence (0, 1, 2, …) for agent channels and the tree channel, and a **byte offset**
  into the output for command and service channels, so a client that asks for "from here" gets the
  bytes after it and no re-framing.
- **Every channel starts with `opened` and ends with `closed`.** `closed` carries the node's final
  state, its outcome and, for a command, its exit code. A channel with no `closed` entry belongs to
  a node that is still running, or, in a conversation that is not live, to one that was lost.
- **The causal link.** A child's `opened` entry records the parent's cursor at the moment the
  child was spawned, so a front end can place the child's channel in the parent's without a shared
  clock or a shared counter.

### The tree channel

It carries three things, each with the node's id:

- the lifecycle of every node: opened, state changes, a change of its status text or model, closed;
- every approval a node's tool asks for, and its answer or cancellation. **Approvals live on the
  tree channel only**, with the id of the node that asked, so one subscription is enough to know
  that anything waits for the user;
- the conversation's own notices: its queue, a storage failure and an extension's own events.

A subscriber can ask for a **snapshot**: the nodes and pending approvals as they stand, with the
cursor to continue from, then the entries after it. A sidebar needs no more than this. The
snapshot is in #438's design, but how a client asks for it is **proposed** here (`from: snapshot`,
below), since #422 lists only `start`, `now`, `tail:<n>` and a cursor.
The tree channel is as sensitive as today's stream: an approval request carries the full command
and its concerns, so a read-only subscriber sees them too.

### Agent channels

An agent channel carries the loop's events as **items** with an id and a lifecycle: `started`,
`delta` and `completed`. The durable log holds the completed items. Deltas are live only, and a
late subscriber gets the completed items plus a snapshot of the item in progress.

That is the principle. The work is scheduled in two phases so nothing waits for it: the first
phase wraps today's events, unchanged in content, in the new per-channel envelope, and stores
every entry as today does (the entry log keeps all of them, live-only ones included); the item
model comes later (#434). `text_delta`, `reasoning_activity` and `run_state` are the entries that
become live only in the item model, and until then are stored with the rest.

### Command and service channels

Their entries are output: bytes with the offset they start at, and the `opened` and `closed`
entries around them. A bounded preview still rides in the node's lifecycle entries on the tree
channel, as `TaskInfo.output` does today, but the complete output is read by subscribing to the
channel from an offset (#428).

## Subscriptions

One endpoint, `QUERY /conversations/{id}/subscribe`. Its body is a list of channels and where to
start in each:

```
{ subscriptions: [ { channel, from }, ... ], approvals?: boolean }
```

`from` is `start`, `now`, `tail:<n>`, a cursor the client was given, or, **proposed**, for the tree
channel only, `snapshot` (see above). `tail:<n>` is the last `n` entries of a sequence channel and
the last `n` bytes of a byte-offset channel. The response is a stream of server-sent events, and
each frame is one envelope: it carries its **channel and its cursor**. A closed channel delivers
what remains and then completes. A slow consumer is cut off per channel and resumes from its
cursor.

The server keeps no resumable state: what a connection holds (a place in a queue, the flag below)
goes with it. A frame's id cannot carry several cursors, so `Last-Event-ID` is no longer used for
streams: on reconnect a client re-sends its last cursor for each channel in the body, and the
server starts each channel after it.

**The `approvals` flag is kept** (#426 keeps it). It is today's flag and it says that this client
answers approvals: while one such client is connected, an approval waits for an answer, and with
none connected an approval is refused at once. It is not implied by subscribing to the tree
channel, which a read-only sidebar or a notification also does: only a client that sets it
counts. It is a claim, not a check: any holder of the token may set it and may answer any
approval of the conversation, as today, and a client that sets it and never answers holds every
approval until it disconnects. **Proposed:** a request that sets it without the tree channel is
refused, since it could not see an approval to answer.

A client subscribes to the tree channel to know what exists, and to a node's channel only when it
shows that node. Following one sub-agent is one subscription, not a filter over everything.

### What a subscription must check

The path names the conversation, so the server resolves every `channel` of the body **inside that
conversation only**. A channel of another conversation and a node id that does not exist answer
the same `not_found`, so a client learns nothing about conversations or nodes it cannot reach. A
cursor never selects a conversation. Each entry of the list is checked, and the request is refused
on the first that fails, before anything is sent: the refusal is an HTTP status decided before the
event stream opens, since a stream cannot change its status once it has begun. `snapshot` and
`tail` go through the same per-channel check and the same bounds as a cursor.

A request is bounded. Each of these limits must exist, as a number in the schema, and a request
past one is refused with a typed error: the number of subscriptions in one request, the `n` of
`tail:<n>`, and the size of a byte-offset replay in one read (the output store's own read bound,
`MAX_READ_BYTES`, is the natural one). A cursor out of range (negative, not a whole number, past
the end, or before what the log still holds) is the same kind of error and never a silent clamp. A consumer that
does not keep up is cut off per channel, as above, and a subscription at `from: now` on a channel
nothing writes to is a held connection, so the number of connections a conversation serves is
bounded too. The numbers are #422's and #426's to set; this page says each must exist.

Every route the model adds is private: it needs the bearer token like every route that does not
say `public` (the route table in [the contract](contract.md#what-a-server-accepts-and-answers)
marks the two that are).

## Commands

A command returns at once; what it did arrives on a subscription, never in its own answer. That
is already so for `POST .../prompts`, which answers `{ status, queued }` (see "What exists
today"); #429 adds the ids. A command is addressed **by node**, and the effects arrive on the
channels.

- **Cancel**: `POST …/nodes/{node}/cancel`, for every kind of node, with today's kill semantics.
- **Send a message**: `POST …/nodes/{node}/messages`, to an agent node. **Proposed:** a message to
  a sub-agent and the user's steering are the same command with a different sender; #429 names
  only the route.
- **Stop, yield and the approval answer stay as they are.**

**Answering an approval** stays `POST /conversations/{id}/approvals/{approval}`. It is answered by
its id inside the conversation the path names, once, with a response among the options the
request offered; an id that is not pending there is `unknown_approval`. The node id on the tree
channel says who asked, for display, and is never what authorizes an answer. Today an approval id
is a counter of its conversation's registry (`a1`, `a2`, …) that starts again when the
conversation is reopened, so ids are not unique across conversations, and a stale client can
answer a newer approval that has the same id. **Required of the schema work (#422):** an approval
id is unique within a conversation for as long as the server keeps it, reopening included, so an
answer can only ever mean the approval it was made for.

Reading a command's or service's complete output, listing nodes and cancelling one are new: no
route does them today.

## Ordering

**Per-channel cursors, not one global order.** Within a channel the cursor is the order. Across
channels, causality is carried by links (the child's `opened` records the parent's cursor), and
`at` is enough for display. This reverses the "one ordered stream" goal of #21 and #23.

There is **no per-conversation order stamp for now.** One can be added to durable entries, assigned
by an in-process counter and never used as a cursor, when a consumer needs a merged order, such as
a replay or an export tool.

## A restart

When a conversation is reopened, every node that was not finished when the server stopped is closed
as `lost`: a `closed` entry is written to its channel, and the tree channel records the state
change. A channel with no `closed` entry in a conversation that is not live is repaired at that
point. The restart notice #399 describes stays; `lost` is what a client reads to know it.

## Storage

Per-channel logs, one append-only file or table per node channel. The cursor is the channel's own:
the byte offset into its output for a command or service, the entry's sequence number for the
others. This is the layout #246 (a SQLite database per workspace) keeps behind the same
interface. A conversation stored in the old layout (one stream of everything) is migrated when it
is first opened (#437).

## Transport

HTTP with server-sent events. The envelope does not depend on the transport. A WebSocket is
reserved for an interactive attach to a task, if input to tasks is ever built; it is not part of
this design. The server's missing `Origin` and `Host` check is added regardless (#435). **Proposed:**
it lands before or with the subscribe endpoint (#426) and the complete output (#428), which expose
more through the same bearer token, so that output with secrets is never newly readable on a
server without the check. The issues do not say so: #435 is independent in #438's list.

## Who may read what

Any token holder reads a task's complete output, for now, once the output is served (#428). Today
no route serves it: the stream carries only the bounded preview (`TaskInfo.output`), and an
extension holding the `output:read` grant reads it through its own service. Command output may
contain secrets (the host's run-services doc says the output store holds every command's output),
so a front end treats it as untrusted terminal text and escapes it as the terminal's
`plainTerminalText` does, never passing it to the screen as it is. Scopes and redaction wait until
a remote server exists. Two caveats: what the model read with the output tool, and a command's
result, is already in the history that `GET …/messages` and the stream carry, so the complete
output is reachable through history today for what the model asked to see; and the bytes of an
output channel can split a multi-byte character, so how #428 frames them (base64, or boundaries
that keep a character whole) is its decision to make.

**Open, and not decided here: what profiles mean for this.** Today one server holds one token,
and every route that takes a conversation id accepts any conversation the server keeps, whichever
profile it runs on. Profiles separate credentials, models and where a conversation is stored; they
are not a security boundary between token holders. So when the complete output is served (#428), a
client that holds the token can read it for a command in a conversation on any profile. #438
accepted that with a caveat about profiles that was to be written down. This paragraph is the facts as the code has them. What
the caveat should say, and whether profiles are ever to be a boundary, is a decision for the owner.

## Where each current entry goes

Every entry the stream carries today, 39 in all, has a place in the model: see
[the mapping](wire-model-mapping.md). It also lists the three decisions the mapping leaves for the
schema and registry work.

## Who changes

Every workspace that reads or writes today's stream, found by what imports it, with what changes
in each and in which issue: see [the consumers](wire-model-consumers.md).

## What this changes

All of it is sub-issues of #387, one pull request each, blocked by #438 through #422:

| Issue | What it does                                                              |
| ----- | ------------------------------------------------------------------------- |
| #422  | The node and channel schemas in the protocol                              |
| #423  | One node registry in place of the session and task registries             |
| #424  | The host's scopes, the loop's task delivery and the tools on the registry |
| #425  | Each node's channel as its own log in storage                             |
| #426  | One subscribe endpoint serving node channels                              |
| #427  | The tree channel and its snapshot                                         |
| #428  | A command's or service's output through the API                           |
| #429  | Commands addressed by node; prompts answer with ids                       |
| #430  | The client on subscriptions                                               |
| #431  | The terminal chat on subscriptions                                        |
| #432  | Replay and the workbook reading channel logs                              |
| #433  | Extensions contributing node kinds                                        |
| #434  | The item model on agent channels                                          |
| #435  | The `Origin` and `Host` check, before or with #426 and #428               |
| #436  | Removing the old stream, session and task wire types                      |
| #437  | Migrating conversations stored in the old layout                          |

The first release waits for this: the protocol version is not frozen until the model is built. It
does not hold up the discovery, service and `sheavly` command work, which touch no event schema.
#399 and #415 are built on today's stream, and wait for this decision or are written against the
new model.

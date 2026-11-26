# The wire model: nodes, channels and subscriptions

How a front end follows a conversation's agents, commands and services. The decision is
[#438](https://github.com/Sheavly/harness/issues/438); this page is its specification. **The
schemas are built** and described in [the contract](contract.md#the-wire-models-schemas). **The
rest is only partly**: one route serves the node channels, the tree channel and a command's output
(`QUERY /conversations/{id}/subscribe`, see "What is built of subscriptions" below). The client and
the terminal do not read it yet. That work is split into the issues in "What this changes" below,
and until it lands the single combined stream in the contract is the wire for them. Where this page and a schema differ, implement
against the schema and treat the difference as a defect in one of the two, to fix.

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
- No route lists tasks. A task's complete output is kept (`outputLog`, and the output store's
  byte-ranged `read`), but only a bounded preview travels on the stream; the subscribe route serves
  the complete output as its node's channel (see "Command and service channels"). A node is
  cancelled, and the main agent messaged, by node (see "Commands").
- `POST /conversations/{id}/prompts` answers at once and never with a stream: with `PromptSent`,
  the agent node that carries the run and the message a started prompt became; what the prompt does
  arrives on the conversation's stream and the node's channel. (The issue that started this design
  described an older shape, so #429 was narrower than its title.)

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
the call starts, so the two are joined from both sides. `task_running` carries that node id
(`nodeId`) next to its `TaskInfo`, whose `id` is only the task's counter, and a sub-agent's task
carries the session it runs (`TaskInfo.agentSessionId`). The node id is the node's address in the
tree; the session id is the key that stays the same when a conversation is reopened, so it names a
task's agent without the tool call id, which a provider repeats. `nodeId` is optional in the schema
only so that a stream stored before it existed still reads.

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
- **The cursor is defined by the channel**, and a client never builds one. It is opaque text with
  its kind in the first letter, so a client keeps it whole and sends it back, and a cursor of the
  wrong kind for its channel can be told apart. Two kinds exist: `s` and a gapless position
  (`s0`, `s1`, `s2`, …) for agent channels and the tree channel, and `b` and a **byte offset**
  (`b0`, `b4096`) into the output for command and service channels, so a client that asks for
  "from here" gets the bytes after it and no re-framing. A kind an extension adds chooses one of
  the two. At most fifteen digits, so the number is exact when it is read back.
- **Every channel starts with `opened` and ends with `closed`.** `closed` carries the node's final
  state, its outcome and, for a command, its exit code. A channel with no `closed` entry belongs to
  a node that is still running, or, in a conversation that is not live, to one that was lost. The
  schema cannot know a node's kind from its channel's entries, so the registry holds what it
  cannot: an outcome only on an agent's `closed`, an exit code only on a command's or service's,
  none on `lost`, and a cancelled idle agent closed with the outcome `interrupted`.
- **The causal link.** A child's `opened` entry records the parent's cursor at the moment the
  child was spawned, so a front end can place the child's channel in the parent's without a shared
  clock or a shared counter. The stored channels name the newest parent entry the store holds when
  the child's entry is written, which is the same entry unless a write of the parent's failed.

### The tree channel

It carries three things, each with the node's id:

- the lifecycle of every node: opened, state changes, a change of its status text or model, closed;
- every approval a node's tool asks for, and its answer or cancellation. **Approvals live on the
  tree channel only**, with the id of the node that asked, so one subscription is enough to know
  that anything waits for the user;
- the conversation's own notices: its queue, a storage failure and an extension's own events.

A subscriber can ask for a **snapshot**: the nodes and pending approvals as they stand, with the
cursor to continue from, then the entries after it. A sidebar needs no more than this. A client
asks for it with `from: snapshot` (below); it is a view, not an entry of the channel's log, and
it holds together: each node once, each parent among the nodes, each approval once and asked by a
node in it. The tree channel is as sensitive as today's stream: an approval request carries the full command
and its concerns, so a read-only subscriber sees them too.

### Agent channels

An agent channel carries the loop's events as **items** with an id and a lifecycle: `started`,
`delta` and `completed`. The durable log holds the completed items. Deltas are live only, and a
late subscriber gets the completed items plus a snapshot of the item in progress.

That is the principle. The work is scheduled in two phases so nothing waits for it: the first
phase wraps today's events, unchanged in content, in the new per-channel envelope, and stores
every entry as today does (the entry log keeps all of them, live-only ones included); the item
model comes later (#434). `text_delta`, `reasoning_activity`, `model_connection` and `run_state`
are the entries that become live only in the item model, and until then are stored with the rest.

### Command and service channels

Their entries are output: text with the byte offset it starts at, and the `opened` and `closed`
entries around them. A bounded preview still rides in the node's lifecycle entries on the tree
channel, as `TaskInfo.output` does today, but the complete output is read by subscribing to the
channel (#428, built).

**The output is made, not stored in the channel.** The stored channel is `opened` and `closed`. The
host reads the output log the node kept (the reference is in the `opened` entry's `outputLog`) and
sends it as `output` entries between them, so no byte is stored twice. A command whose output was
not stored (past the log count, or storage failing when it started) has a channel with no output
entries and no `output` on its `closed` entry.

**Chunk encoding: UTF-8 text in a JSON string, cut between characters.** The output store holds
text (its writer takes strings and encodes them as UTF-8), so the output is always whole
characters, and an entry's `text` is a string: no base64, which would cost a third more and be
unreadable for what is text, and no character split between two entries. An entry holds at most
16 KiB of bytes (`MAX_OUTPUT_CHUNK_BYTES`, counted in bytes: a character is up to four), is never
empty and holds no lone surrogate. Its `offset` is the byte offset of its first byte and its cursor
is the offset after it (`b<offset + bytes>`), so a client that keeps the last cursor it saw and
sends it back asks for the bytes after it, and the next entry starts where the last ended. A reader
that starts at an offset inside a character moves forward to the next one, which is why `offset`
is a field and not only the cursor. An entry is not stored, so it is not held to the stored-entry
cap: a chunk of control characters is up to six times its size as JSON, which a subscription
counts against what a conversation may hold. Its `at` is not when a byte was printed, which the
output store does not keep: for live output it is when its first bytes were stored (also for what
was stored while the history was being read), and for the
history of a node that has ended it is when the node ended, so no output entry is later than the
`closed` entry that follows it (for a running node's history it is the time of the read).

- **Positions.** `start`: `opened`, all the output, then `closed` once the node has ended. A
  cursor `b<n>`: the bytes from `n`, never `opened` again; one past the end is
  `cursor_out_of_range`. `tail:<n>`: the last `n` bytes, with `opened` only when they reach the
  first. `now`: a `head` frame at the size the output stands, then what comes.
- **History is bounded as any history is.** What a request reads is charged to its 8 MiB and to the
  conversation's pool, so a `start` on an output too large for a request is refused (`bad_request`),
  never cut: the client asks from a cursor or a tail. A read that could not fit even as the cheapest
  text (three bytes to a character of JSON) is refused before it reads anything, and any other that
  outgrows the budget after reading up to it, giving back what it held. A read the output store
  fails is `storage_failed`. **History is not paged**: a
  position more than about 8 MiB behind the end of the output cannot be resumed from in one
  request, so a client that fell that far behind (a cut-off client of a fast command) can only ask
  for a tail, which skips bytes, and the complete output of a larger log is not readable through
  this route yet. Serving history in pages, paced to the consumer, is not built.
- **Live output is pushed, and joined by offset.** The capture tells the subscription each chunk
  once it is stored; the subscription follows before it reads, as for any channel, so what is
  stored while the history is read is told and kept. Where the read ended is the join: a chunk
  wholly before it is dropped, one that overlaps it is cut at that byte, one that starts after it
  is sent whole, and one that starts beyond a gap cuts the channel off (`cut_off`: the client
  resumes from its cursor and reads what lies between). The bytes decide, not how the store and
  the capture cut the output, so none is missed or sent twice. What the capture tells while the
  history is read is kept, up to 1,000 chunks and 1 MiB for a channel (not counted against the
  pool); past that the channel is cut off when the history is joined, and the client reads the
  rest from the store. After an `end` no more frames of the channel follow.
- **Batched for at most 100 ms** (`OUTPUT_BATCH_MS`): what is stored within the window goes out as
  one entry, or at once when it is a whole 16 KiB, so a command that prints a character at a time is
  not a frame for each, and a client sees it at most that late.
- **`closed` comes after all of the output and stands where it ends**, with the exit code and
  `output: { status, reason? }`: `complete`, or `incomplete` with what was lost (a limit, a failed
  write, a stalled disk), so what was served is a prefix and never presented as all of it. A node
  that was lost has no size of its own, so its `closed` is served at the end of the output it
  printed, never at 0: a channel's offset does not go back. It has no `output` either: that its
  state is `lost` is what says the end of the output may be missing. If the disk stalled while the
  log was closing, `incomplete` says so and a late chunk may follow the node's end unsent.
- **Each subscription does its own work.** Every follower of a command counts, encodes and
  serializes what the command prints for itself, so a conversation's 64 subscriptions to one command
  that prints fast cost about 64 times that of one, on the server's one thread. There is no rate
  limit (see the API's security notes); sharing that work between followers is not built.
- **A consumer that does not keep up is cut off**, as on any channel: the frames that waited are
  dropped and the client resumes from the cursor of the last frame it got, which reads the rest
  from the store.

## Subscriptions

One endpoint, `QUERY /conversations/{id}/subscribe`. Its body is a list of channels and where to
start in each:

```
{ subscriptions: [ { channel, from }, ... ], approvals?: boolean }
```

`from` is `start`, `now`, `tail:<n>`, a cursor the client was given, or, for the tree channel
only, `snapshot` (see above). `tail:<n>` is the last `n` entries of a sequence channel and the
last `n` bytes of a byte-offset channel. The response is a stream of server-sent events, and
each frame is one envelope: it carries its **channel and its cursor**. A closed channel delivers
what remains and then completes. A slow consumer is cut off per channel and resumes from its
cursor.

A stream has four kinds of frame, each a JSON `data` with no `id` (`SubscribeFrame`):

- **`entry`**: one entry of a channel, as it is stored (`opened`, an agent's `updated`, `closed`,
  as `ChannelEntry` says; on the tree channel, `TreeChannelEntry`). Its own `channel` and `cursor`
  are the frame's.
- **`snapshot`** (`TreeSnapshot`): for `from: snapshot` on the tree channel, the tree as it stands,
  sent first, with the cursor of the entry it covers up to; the entries after that cursor follow.
  `applyTreeEntry` is the one rule from entries to tree, so a client that starts from a snapshot
  and one that replays every entry from the start end with the same tree.
- **`head`** (`ChannelHeadFrame`): where a channel stood when a subscription at `now` opened,
  the cursor of its newest entry, sent first, once per such channel. A client that hears no entry
  before the connection drops still has a cursor to resume after, and misses nothing written
  meanwhile. It is not an entry of the channel's log.
- **`end`** (`ChannelEndFrame`): one channel of the subscription ended, and no more frames of it
  follow. `completed`: its `closed` entry was delivered. `cut_off`: this consumer did not keep up
  with it, or the conversation's subscriptions hold as much as they may. `failed`: no more of its
  entries will come, because storing the channel failed or no writer has it; a reopened
  conversation closes it as `lost`. `cursor` is
  that of the last frame delivered for the channel, an entry's or the head's, absent when none
  was, and the client resumes after it, or asks again from its position when there is none. The
  other channels go on, and the stream closes after the last one ends.

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
approval until it disconnects. A request that sets it without the tree channel is refused, since it
could not see an approval to answer.

A client subscribes to the tree channel to know what exists, and to a node's channel only when it
shows that node. Following one sub-agent is one subscription, not a filter over everything.

### What a subscription must check

The path names the conversation, so the server resolves every `channel` of the body **inside that
conversation only**. A channel of another conversation and a node id that does not exist answer
the same `not_found`, so a client learns nothing about conversations or nodes it cannot reach. A
cursor never selects a conversation. Each entry of the list is checked, and the request is refused
on the first that fails, before anything is sent: the refusal is an HTTP status decided before the
event stream opens, since a stream cannot change its status once it has begun. `snapshot` and
`tail` go through the same per-channel check and the same bounds as a cursor. Whether a channel
exists in this conversation is checked first, so a position is never judged against a channel the
client may not know of: only a channel that exists can answer `cursor_out_of_range`.

A request is bounded, and a request past a limit is refused, never cut or clamped. The schema
holds these: at least one channel and at most 32 (`MAX_SUBSCRIPTIONS`), none twice, and a `tail`
of at most 65,536 (`MAX_TAIL_BYTES`, which a test pins equal to the output store's read bound
`MAX_READ_BYTES`, so a tail is one read) and at most 1,000 entries (`MAX_TAIL`) on the tree
channel, which is numbered. Those are `bad_request`, as is a cursor that is not one.

The schema cannot see which kind a node's channel is, so **the server must apply the rest per
resolved channel, before it reads anything**: a `tail` is read as entries on a channel that numbers
them and as bytes on an output channel, and its `n` is at most `tailLimit` of that kind (`MAX_TAIL`
on an agent's channel, which the schema lets through at the byte bound); a cursor of the wrong kind
for its channel (an `s` cursor on an output channel, a `b` cursor on an agent's) is `bad_request`,
and so is a cursor of a kind a node kind that "chooses" did not choose. What only the server can
tell is `cursor_out_of_range`, a code of its own: a cursor past the end of a channel or before what
its log still holds, so a client asks again from `start` or a snapshot. A consumer that does not
keep up is cut off per channel, as above, and a subscription at `from: now` on a channel nothing
writes to is a held connection, so the number of connections a conversation serves is bounded too.
The schema bounds each subscription, not the sum: 32 channels of 65,536 bytes or 1,000 entries are
all in bounds, so the server bounds the sum too, and the connections: a request reads at most
8 MiB of stored history across its channels and is refused as `bad_request` for more, never cut
(a tail on a numbered channel is charged for what it sends, not for what it leaves out), and a
conversation serves at most 64 subscriptions at once, refused as `too_many_subscriptions` (`429`).
What a conversation's subscriptions hold is bounded in bytes too, 128 MiB all together, from the
moment their history is being read: history that does not fit refuses the request the same way, and
a live frame that does not fit cuts its channel off. A client that leaves while its history is read
stops that read.
`approvals` needs the tree channel, where an approval is seen. The server honours the claim: the
conversation counts the connection as one that answers approvals from the moment the request is
accepted, before its history is read, until the subscription closes, and gives that back on every
way out (the client leaving, a refusal, a read that fails). A request that makes no claim leaves
an approval refused at once, so a read-only sidebar or a notification is not mistaken for one that
answers.

Every route the model adds is private: it needs the bearer token like every route that does not
say `public` (the route table in [the contract](contract.md#what-a-server-accepts-and-answers)
marks the two that are).

## Commands

A command returns at once; what it did arrives on a subscription, never in its own answer
(#429, built). `POST .../prompts` answers `PromptSent`: the agent node whose channel carries the
run (the main agent's) and, for a prompt that started, the id of the user message it became,
which is read as the prompt starts and is the one the tree channel's `prompt_started` names. A
prompt that waits in the queue has no message yet, so its answer has none. A command is addressed
**by node**, and the effects arrive on the channels.

- **Cancel**: `POST …/nodes/{node}/cancel`, no body, `204`. A command, a service and a sub-agent
  are killed through their task, as the agents' `cancel_task` does, and the request waits until the
  process has exited **for at most 10 seconds** (`NODE_CANCEL_WAIT_MS`): a process that cannot be
  killed never ends its task, and the answer is then that the kill was sent. The main agent is only
  signalled, as `POST …/stop` does (the conversation's one prompt switch), and with no prompt
  running that does nothing. A kind nothing can cancel (an extension's) is `400 bad_request`. The
  agent that started the node is **not told** it was cancelled (no notice is queued, as for any
  cancel); it learns from the node's end on the tree. Whether the user's cancel should tell it is
  open.
- **Send a message**: `POST …/nodes/{node}/messages`, `{ text }`, `204`. The request
  (`MessageNodeRequest`) holds only the text: who sent it is the caller, which here is the user. The
  main agent takes it at its next model call. An inbox holds at most 100 messages and 400,000
  characters together (`MAX_QUEUED_MESSAGES`, `MAX_QUEUED_MESSAGE_CHARS`) until the agent takes
  them: past that a message is `409 cannot_queue`, as for a full queue, until the agent has taken
  them (a running agent at its next model call, an idle one only at its next prompt). **A sub-agent is refused
  (`400 bad_request`)**: it is messaged only by the agent that started it, a rule of the session
  registry that this keeps rather than changes, so the user cannot steer a sub-agent through the
  API yet. A command, a service and an extension's node are no agent (`400`).
- **A command to a node that ended** is `node_ended` (`409`), apart from a node that is not there
  (`404 not_found`). A node that ended counts as ended after it is released too: a conversation
  releases a finished node once its end is reported, soon after it ends, and the registry remembers
  the ids it released. **After a restart and a reopen the nodes of the first life are history**: the
  tree lists them (the main agent `lost`, an ended command as it ended), but a command to one is
  `404 not_found`, since the reopened conversation's live nodes are new ones; the live main agent's
  node comes from the tree and from the answer of a prompt (seen on a real server, not a gap the
  commands close yet). The node is resolved inside the conversation the path names, as a channel is: a node
  of another conversation is `not_found` too, as is an id that is not a node id's shape, and
  existence is decided before `node_ended`, so a client learns nothing about a node it cannot
  reach.
- **Stop, yield and the approval answer stay as they are.**
- Any token holder may command any node of any conversation the server keeps, as it may read it
  (see "Who may read what"): there is no scope yet.

**Answering an approval** stays `POST /conversations/{id}/approvals/{approval}`. It is answered by
its id inside the conversation the path names, once, with a response among the options the
request offered; an id that is not pending there is `unknown_approval`. The node id on the tree
channel says who asked, for display, and is never what authorizes an answer. An approval id was a
counter of its conversation's registry (`a1`, `a2`, …) that started again when the conversation
was reopened, so ids were not unique across conversations, and a stale client could answer a newer
approval that had the same id. **The approval registry makes the ids and holds this:** an id is
`a-` and a random UUID, unique within a conversation for as long as the server keeps it, reopening
included, so an answer can only ever mean the approval it was made for, and a registry made later
refuses an id it never issued. A schema cannot say "unique", so the protocol does not pin it; the
registry's tests do.

Reading a command's or service's complete output (#428) and listing nodes (the tree, #427) are
built; cancelling one node is new: no route does it today.

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

What is built: the host closes every node channel the store holds with no `closed` entry, before
the reopened conversation has a node of its own, with state `lost`, no outcome and no exit code,
at the next position of a numbered channel and at the last offset of a counted one. It does so
once: a channel that ends in `closed` is left alone, so reopening again changes nothing. A channel
the store refuses another entry for, being at a limit, is left as it is, and reads as lost. The
tree channel is stored too and goes on from where it was: each node the stopped process left open
is closed on it as `lost` (a `node_closed` entry with the node as the tree last had it), and each
approval it left waiting is given up (`approval_cancelled`), since nobody can answer it now. This
process's own main agent opens after them, so a snapshot after a reopen shows no node as running that
is not. A stored tree channel that cannot be gone on from (an entry no client could read, or one
that ends in `closed`) is not written: the conversation still reopens, and the failure is told once
as `storage_failed`.

## Storage

Per-channel logs, one append-only file or table per node channel. The cursor is the channel's own:
the byte offset into its output for a command or service, the entry's sequence number for the
others. This is the layout #246 (a SQLite database per workspace) keeps behind the same
interface. A conversation stored in the old layout (one stream of everything) is migrated when it
is first opened (#437).

What is built: `ConversationStore.channel({ id, channel })` is the log of one channel, kept by the
file store as `channels/<channel>.jsonl` beside the stream, which is still written. An agent's,
a command's and a service's channel are stored as the conversation runs, with `opened`, `updated`
for an agent and `closed`; the tree channel is stored beside them (`channels/tree.jsonl`, numbered
from `s0`, never closed while its conversation exists, so a reopen can go on from it), and the kinds
an extension adds are not. A stored line
is one entry of at most 64 KiB, so a command longer than that is shortened in its `opened` entry.
Retention is per channel: 128 MiB for a channel, 1 GiB and 5,000 channels for a conversation, and a
channel that refuses an entry for a limit takes no more. The layout, the rules and the limits are
in the [storage design](../../storage/docs/design.md).

What is built of subscriptions: `QUERY /conversations/{id}/subscribe` (`streamChannels`) serves the
channels the store keeps for a conversation's nodes (an agent's, a command's and a service's) and
for its tree, stored history and then what the channel's writer stores next, joined by each entry's
place in its log so none is missed or sent twice. The tree channel is served like any other, and
from `snapshot` it sends the tree as one frame first (`GET /conversations/{id}/tree` answers the
same snapshot with no stream), then the entries after its cursor. A command's or a service's channel
carries its complete output between its `opened` and `closed` entries, made from the output store
and followed as the capture stores it, joined by byte offset (see "Command and service channels").
A channel that does not exist, belongs to another conversation, or is the tree of a conversation
that keeps none is `not_found`, with one message. A channel with more than 1,000 live frames waiting for its consumer, or whose frames would
take the conversation's subscriptions past what they may hold, is cut off on that channel (`end`
with `cut_off`), and a channel whose storage failed, or that no writer has, ends as `failed`. A
conversation that closes ends its node channels with their `closed` entries, which a client reads
like any other, and its tree channel as `failed`: the writer stopped, and the channel is not closed,
so that a reopen goes on from it. The client has no reader for these frames yet: they carry no `id`,
which its stream reader requires.

The snapshot is held in memory by the server, so it counts against what a conversation's
subscriptions may hold (128 MiB) and not against the 8 MiB of stored history a request may read:
that bound would make the tree of a long conversation unservable. The tree keeps at most
`MAX_TREE_NODES` nodes (`applyTreeEntry` drops the oldest ended one nothing hangs from), and an
entry of the tree channel is cut to 16 KiB of JSON (16,384 characters), a quarter of what a store
keeps, so that a snapshot at its bounds is about 32 million characters: about 32 MiB of ASCII, up to
three times that in bytes for wide characters. What does not fit is cut: an approval's command,
concerns and tool name, with its first concern saying so and the request then offering only to skip
it, and its call id, which is cut to what a node keeps of one (200 characters) whatever its size; a
command's command, output (its start is dropped and its end kept), description, reason and error, the
costliest first; an answer's message, with a trailing `…`. The whole command is on the
conversation's stream. A cut never lands inside a surrogate pair, and a lone surrogate in a text that
is cut is replaced; an approval request that fits is stored as asked, as the stream carries it, so
a strict JSON reader reads its text with the same care it reads the stream's. The tree channel has
a channel's usual 128 MiB quota, counted in bytes, and shares the conversation's 1 GiB with the node
channels; a client that changes the queue some thousand times can fill it, and the tree then stops
being written and its snapshot is refused (`507`) for the life of the conversation.

## Transport

HTTP with server-sent events. The envelope does not depend on the transport. A WebSocket is
reserved for an interactive attach to a task, if input to tasks is ever built; it is not part of
this design. The server checks the `Origin` and `Host` of every request (#435, built): it came
before the subscribe endpoint and the complete output (#428), which expose more through the same
bearer token, so that output with secrets is never readable on a server without the check. A request for a name the server does not list, or that carries an origin it does not list,
is `403 forbidden` before any route, public ones included; the names and origins are
`SERVER_ALLOWED_HOSTS` and `SERVER_ALLOWED_ORIGINS` ([the API](../../../apps/backend/docs/api.md#security)).

## Free text in the schemas

Every free-text field of a node and of the tree channel is untrusted text, whatever the schema
checked: a command's `command`, `description`, `output` and `error`, the `text` of an `output`
entry (what a command printed, with any escape sequence it wrote), an extension's `text`, a queued
line, an approval's command and message. A front end escapes each as the terminal's
`plainTerminalText` does and never passes it to the screen as it is, since `text` and the others
accept escape sequences. Only a node's `title` and status text are refused them, as one line of
plain text (the terminal test in `apps/terminal` holds that rule to the terminal's class).

The schemas bound these: a node's `command` is at most 131,072 characters, its `description` 2,000,
an `await_tasks` reason 1,000, its `output` 30,000 (the most the runtime keeps, pinned equal by a
test there), an error text 2,000, a tool call's id 200, a queued line 20,000 and an entry's `type` 128. A cap is a bound for the wire and not a limit the system puts on a producer: `run_command`
takes a line of any length, `await_tasks` a reason of any length and a failed task's error is its
message as it is, so **whoever builds a node's body for the wire shortens each**, or a long one
would have no valid node (the node registry holds only a node's title and status, and shortens
those). A snapshot holds at most 1,000 nodes and as many approvals: the node registry refuses a
node past the first bound and the approval registry a request past the second, so a snapshot never
has to be refused instead. The tree keeps every ended node, so over a long conversation it would
outgrow the first bound while the registry does not: `applyTreeEntry` drops the oldest ended node
that no node under it needs once the tree holds more, so a snapshot and a replay stay the same
tree and a child never points at a node that is gone. A node id is lowercase, so
two cannot differ by case on a disk that ignores it.

What they do not bound, so a front end and a server must: an approval's own fields (`id`, `tool`,
`command`, `concerns`, `options`, the answer's message) are the approval schema's, unchanged;
an output log's `reason`; the `data` of an extension kind is capped in bytes but not in depth, and
a value nested a few thousand levels deep makes `safeParse` throw a `RangeError` before the byte
cap is checked, so a client wraps parsing of a frame in a `try` and drops the frame; the array of
`channelLogSchema` and any extra field of its entries, which are loose on purpose, so whoever feeds
it bounds the input; and a snapshot as a whole, since 1,000 nodes at their caps are a large
document, so the server counts it against what the conversation's subscriptions may hold (#427). A title is one line but not an identity: look-alike
letters, combining marks and a title like another's are accepted, and only text that draws as
nothing is blank.

An extension's name is not reserved by the manifest: a node kind and a tree event cannot use
`agent`, `command`, `service` or `tree` as their extension, but a manifest can still be named so,
and its kinds and events are then refused (#433 adds the check at the manifest).

## Who may read what

Any token holder reads a task's complete output, for now: the subscribe route serves it as the
channel of its node (#428). **Command output may contain secrets**: a command prints whatever it
prints (an environment, a credentials file, a token in a URL), and the output store holds every
command's output, all of it, not the bounded preview the stream carries. The server does not look
for secrets and does not redact: whoever may subscribe to a conversation reads everything its
commands printed. A front end shows it as untrusted terminal text, escaping it as the terminal's
`plainTerminalText` does and never passing it to the screen as it is, since it holds whatever
escape sequence the command wrote. Scopes and redaction wait until a remote server exists. Two
facts about what is already reachable: what the model read with the output tool, and a command's
result, is in the history that `GET …/messages` and the stream carry, so some of the output was
reachable through history before this; and an extension holding the `output:read` grant reads it
through its own service. The `Origin` and `Host` check (#435) is in front of the route, as of
every route.

**Open, and not decided here: what profiles mean for this.** Today one server holds one token,
and every route that takes a conversation id accepts any conversation the server keeps, whichever
profile it runs on. Profiles separate credentials, models and where a conversation is stored; they
are not a security boundary between token holders. So a client that holds the token can read the
complete output of a command in a conversation on any profile (#428 serves it). #438 accepted that
with a caveat about profiles that was to be written down. This paragraph is the facts as the code
has them. What the caveat should say, and whether profiles are ever to be a boundary, is a decision
for the owner.

## Where each current entry goes

Every entry the stream carries today, 40 in all, has a place in the model: see
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

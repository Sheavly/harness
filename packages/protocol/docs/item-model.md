# The item model for agent channels

The design behind the principle in [the wire model](wire-model.md#agent-channels): an agent's
channel carries **items** with an id and a lifecycle, the durable log holds the completed ones, and
deltas are live only. The first phase of the wire model (#511) wrapped today's loop events in the
channel envelope; this note settles the second (#434), before any code, because it touches the
loop, the providers, the channel's storage and every reader of it. It ends in a stack of changes,
each of which builds and passes on its own.

## What is there today

- **The loop emits 24 event types.** A turn is one model call and its tool results. Text, reasoning
  and tool calls stream live; `turn_end` ends the model's part; `tool_batch` lists the turn's calls;
  each call's `tool_result` (or `task_running`) is released after `turn_end`, in the order the tools
  finished, not call order, though a tool may settle while the model still streams. A consumer
  matches a result to its call by `call.id`, and the history keeps call order for the model. The
  release logic (`releaseResults` in the loop's turn) and `tool_batch` exist because the stream is
  an ordered list of events.
- **The adapters give no item boundaries.** The model adapter's stream is `text_delta`, a whole
  `tool_call`, an opaque `reasoning` item, `reasoning_activity`, `model_connection` and `done`: no
  start or stop of a text or reasoning block, and no argument deltas, so a tool starts when its call
  is complete. The Responses mapping reads only function-call and reasoning items as done (a
  `message` item's done event does not parse and is skipped) and drops the ids a Responses stream
  carries (read from the API, not verified here); the Messages mapping has a block index per reply
  and emits its reasoning once, when the reply ends, holding the whole reply's replay content; the
  chat-completions mapping indexes its tool-call deltas and has no text block. The loop sees every
  chunk in order, which is all an item's boundaries need (see the three kinds of item below), so the
  adapters do not change.
- **A provider's call id is not an identity.** It repeats (`call_0` in every turn is seen), it is an
  unbounded string, and the history only checks that it is not repeated inside one assistant
  message.
- **History does not keep the order.** An assistant message is one `content` string, a `toolCalls`
  list and the reasoning, so a reply of text, a call, then more text has no order in history.
- **A channel stores every event.** The channel writer merges the `text_delta` events of a session
  that come within a 50 ms window, counted from the window's first delta, up to 8,192 characters,
  into one entry; any other entry for the channel, or another message, closes the window. Every other
  event is one entry (over 64 KiB, an `event_omitted` stub keeps a call's header).
- **A late subscriber gets the stored log and then what follows.** An agent channel has no snapshot
  (`from: snapshot` is for the conversation's own channels), and a subscription is fed only by what
  the writer stores, so a chat opened in the middle of a reply shows nothing of it until it ends. A
  command's output has the pattern to follow: history from the store, then a live tail joined by
  byte offset (`OutputTail`).
- **The combined stream is separate.** The workbook, the demo, the replay and the client's prompt
  follow read the combined stream of `StreamEntry` events. The terminal chat reads the main agent's
  channel through `watchTranscript`. #436 removes the stream's route and types.

## What it costs today: the baseline

A scripted conversation through the real backend with a stand-in model server (not a provider),
shaped like a real one: six prompts, each a turn with a 120-character preface and a `read_file` call
on a 2 KB file, then a turn with a 1,500-character answer. The text streams in 4-character deltas
**25 ms apart** (about 160 characters a second, the pace of a fast model), 2,430 deltas in all.
The pace matters, because the channel merges deltas that come within 50 ms: the same conversation
with the deltas sent at once, before the pace was set, wrote 12 text entries and a 56 KB channel,
which is not what a model does. The recipe to repeat it: the same prompts, the same pace, then
`wc -c` of the folder's files and a count of the main channel's lines by `type` (and `event.type`).

| File                    | Bytes   | What it is                                                       |
| ----------------------- | ------- | ---------------------------------------------------------------- |
| `stream.jsonl`          | 536,867 | the combined stream, 2,511 entries: 92% of it is unmerged deltas |
| `channels/<main>.jsonl` | 248,863 | the main agent's channel, 990 entries                            |
| `history.jsonl`         | 30,622  | the model's history                                              |
| `channels/usage.jsonl`  | 6,662   | the usage channel                                                |
| `channels/tree.jsonl`   | 4,808   | the tree channel                                                 |

The main agent's channel, by entry type:

| Entry                       | Entries | Bytes   | Share |
| --------------------------- | ------- | ------- | ----- |
| `event:text_delta` (merged) | 909     | 205,455 | 82.6% |
| `event:tool_result`         | 6       | 15,697  | 6.3%  |
| `event:context_added`       | 2       | 5,847   | 2.3%  |
| `event:usage`               | 12      | 4,601   | 1.8%  |
| `updated`                   | 12      | 3,926   | 1.6%  |
| `event:harness_notice`      | 12      | 3,207   | 1.3%  |
| `event:turn_end`            | 12      | 2,669   | 1.1%  |
| `event:tool_batch`          | 6       | 2,087   | 0.8%  |
| `event:tool_call_started`   | 6       | 2,057   | 0.8%  |
| `event:done`                | 6       | 1,926   | 0.8%  |
| `run_started`               | 6       | 1,156   | 0.5%  |
| `opened`                    | 1       | 235     | 0.1%  |

**What this says.** Text is 83% of the channel, in 909 entries for 9,720 characters of text: each
entry is the text of a 50 ms window and about 200 bytes of envelope around it. A message item holds
the reply once. By arithmetic from this table, 12 message items are about 12.7 KB (the text and an
envelope each), a tool call and its result as one item save the `tool_batch` and `tool_call_started`
entries (about 4 KB, less the item's own fields), and the rest stays, so the channel would be
about **50 to 55 KB, a fifth of today's**. That is an estimate; the "after" measurement of this
work is the same table from the same recipe, and replaces it. The stream is the bigger log (537 KB, of
which 492 KB is text deltas) and this work does not change it: the item model is a second output
beside the events the stream carries. Removing the stream's route and types is #436's; whether its
log stops being written is for that change to say.

## The design

### Three kinds of item

| Item        | Starts when                                 | Completes when                                                 |
| ----------- | ------------------------------------------- | -------------------------------------------------------------- |
| `message`   | the model streams the first text of a reply | a content chunk follows it, the cap, or the model call settles |
| `reasoning` | the `reasoning` chunk arrives, whole        | at once: it holds the replay state                             |
| `tool_call` | the model's call arrives                    | the tool settles, with its result                              |

**The loop derives the boundaries from the order of the adapter's chunks**, so no adapter changes. A
message is a run of `text_delta` chunks, started by the first and completed by the next content
chunk (a `tool_call` or a `reasoning`), at the cap, or when the model call settles (its stream
ended by `done`, an error or a stop, and how it ended is known: a call that failed, or that the model
ended with `context_window_exceeded`, completes `failed`, one a stop cut keeps its text and
completes `interrupted`); `reasoning_activity`
and `model_connection` are not content and do not end it, so text on either side of one is one
message. A reasoning item is the `reasoning` chunk, whole and complete when it arrives, like a tool
call item, which is the `tool_call` chunk. `reasoning_activity` stays the live "thinking" signal it
is today and starts no item: a provider sends it with no `reasoning` chunk when it cannot keep the
state, and a `reasoning` chunk with no activity before it when thinking was on and the reply had
no thinking block. The Messages mapping sends its one `reasoning` chunk when the reply ends, after
the text and the tool calls, so its item is the last of the reply and a stored log's order is the
order of completion, never of start. A lost connection mid-reply ends the model call; the turn that
goes on from what arrived is a new model call, with new items, so no item restarts. What an adapter
could add (a start or a stop of a block) the loop already sees.

Everything else stays an entry of its own type, as it is today: `usage`, `harness_notice`,
`context_added`, `model_input_changed`, `turn_end`, `run_state`, `reasoning_activity`,
`model_connection`, the summary and hook events, `run_started` and `done`. They are not pieces of the
reply, and a UI does not need an id to render them. `reasoning_activity`, `model_connection` and
`run_state` are the entries [the wire model](wire-model.md#agent-channels) may make live frames
later: that is a separate step, and they stay stored entries in this work.

**Ids are minted by the loop.** Every item has an `ItemId` (a name proposed here), a lowercase UUID
made when the item starts, unique in the conversation and never taken from a provider: a provider's
call id repeats and is unbounded, and a provider's message id may not exist, so neither can be an
identity, and a minted id cannot collide with one. A tool call item also carries `callId`, the
provider's id, as a hint that joins it to the history (which matches tool messages by call id inside
one assistant message): at most `MAX_OMITTED_CALL_CHARS` characters, and left out when longer or
empty, never cut. The ids do not reach the model.

**A message is at most 8,192 characters**, the size a stored text window is today, counted in
UTF-16 code units and never cut inside a surrogate pair. A longer reply is a run of message items,
each completed at the cap and the next started with the text that follows, so no reply can exceed
what an entry stores and none is lost to the size limit.

**A tool call is one item, with its result inside it.** It starts when the call arrives, which is
when the loop starts the tool, and it completes **when the tool settles**, not when the loop
releases the result: matching is by item, so the item path holds no result for an order, and a UI
sees a fast tool's result while the model still streams. It carries the call's `name`, `input`,
`description` and `turn` (the ordinal of the model call in the run); at completion its result (the
content, `isError`, `artifacts`) and `durationMs`, or, for a call that launched a node (a command, a
service, a sub-agent), the task and the node's id, as `task_running` does. A run's `done` comes
after every one of its tool items has completed, an interrupted one included, so an item is never
published after its channel closes.

**`tool_batch` goes, and so does holding a title.** A tool item holds its title and its result in
one entry, so a reader that draws it when it completes (a replay, a reopened conversation) needs no
`tool_batch` and no held title. The parallel line a live terminal draws ("N tools in parallel") is a
live decoration: it counts the tool items started with the same `turn` and is drawn when the turn
ends. A stored reader does not draw it, because a stored log has the items in the order they
settled, not the order they started.

**Reason.** A completed item says how: `completed`, `interrupted` (the run was stopped by the user,
or the connection was lost, while it streamed) or `failed` (the run was stopped by a failure). A
message cut by a stop keeps its partial text, as the history does. The reason says how the model
call ended, from the run's failure, its stop signal and the model's own stop reason; it does not
say whether the loop kept the reply, which is decided after the items were told (a call the
context window did not fit completes `failed`, and the loop may then drop the reply and try again).
A tool stopped before it settled
completes with the placeholder result the history already holds for every call (the loop makes one
whichever way the stop came, and the loop's start of a tool must say which stopped it), `isError`
set, and its reason says which. An item never stays open once its run is over.

### What the channel stores, and what is only live

- **Durable.** One entry per completed item: `{ channel, cursor, at, type: 'item', item,
messageId? }`, under the channel's own cursor. The `opened` entry of a channel in the item form
  carries `format`, which a release that does not know it refuses (`shipping.md`: data of a newer
  release is left untouched). Other entries are stored as today, except the ones the items replace:
  `text_delta`, `reasoning`, `tool_call_started`, `tool_batch`, `tool_result` and `task_running`
  are not stored as events on a channel in the item form, so no reply is stored twice.
- **An item that does not fit** an entry (64 KiB) keeps its header and drops what is large, each
  marked omitted with its size: a tool item keeps its id, `callId`, name, description and reason and
  drops the result (and the `input`, if that is the large part); a reasoning item drops its replay
  state. The header's own fields are cut to bounds in the stored form, as in a snapshot (the name to
  `MAX_OMITTED_CALL_CHARS`, the description to a few hundred characters), because a model's call can
  carry any length of either and a header over the limit would be refused and end the channel.
  A message never reaches the limit (the 8,192 cap). A large result is kept out of line by
  its own issue (#526).
- **Live only.** A **`live` frame**, a new frame type beside `entry`, `head`, `snapshot` and `end`,
  carries `item_started` (the item's id and kind, and for a tool its name, `callId`, `turn` and a cut
  description, never its `input`) or `item_delta` (a message's text added, with `offset`, the UTF-16
  code units of the item's text before it, cut at a code point). It has **no cursor and no frame
  id**: it is outside the cursor rules, so the client's progress for the channel, which drops any
  frame at or before its last cursor, neither moves nor drops it, its last-cursor reading skips it,
  and a resume by cursor never replays one. The writer sends deltas coalesced in the 50 ms window the
  stored text uses, and flushes the window before it completes the item, so a client sees about
  twenty frames a second, not one for each token.
- **A late subscriber, or a resume.** After the stored entries and before the live frames, **every
  subscription start of an agent channel, a resume by cursor included**, is told the items in
  progress, each as an `item_started` carrying what the item holds so far and its `offset`. A
  delta is then taken as `OutputTail` takes a chunk: dropped when it is wholly told already, cut to
  the part past what was told when it starts inside it (a snapshot can hold text still in the
  writer's window), and taken whole when it starts at the end, so text told while the history was
  read is neither doubled nor lost, and an item that completes in between arrives as its stored
  entry. A delta whose
  `offset` is past the end of what the client has is a gap: the channel is cut off for that
  connection, as an output tail does, and the client's next connection is told a fresh snapshot. A
  client replaces the text it holds for an item with a snapshot's, never appends it.
- **Bounds.** The writer holds at most one open message per agent and at most 64 open tool items
  (a model can start many tool calls, and a tool can wait on an approval; a reasoning item is never
  open); an item beyond that is not in a snapshot and is told when it completes. A snapshot carries at most 8,192
  code units of a message and a tool's header, so it is bounded by the open items and their fields,
  and each field of a header is cut to a bound. A frame holds free text of a provider and a tool,
  which a client prints as untrusted terminal text, like every free text of the wire.
- **What a crash loses.** An item is durable when it completes, so a crash mid-reply loses the open
  reply (today, at most the last 50 ms) and a tool still open leaves no trace (today
  `tool_call_started` is stored). The history keeps the turn: this follows the principle that the
  durable log holds completed items.

### The loop and the combined stream

The loop gives items **beside its events**: an `ItemEvent` union (a separate union, not a member of
`EntryEvent`, so the stream, the hooks, the extensions and the exhaustive switches over events do
not see it), made at the sites that make the events. Items are **not** put through the events'
ordered queue, whose `seq` has no gaps (the stream and the replay depend on it) and whose consumed
count the loop waits for, and they need no queue of their own: each is published at the moment it
happens, straight into **a feed of the sessions registry that does not go through the entry log**,
so an item is never in the combined stream or the replay. The registry's listeners are
synchronous, so what one hears arrives in the order the loop made the items in, with no position to
merge by, and an item is published before its run's `done`. The feed gives each listener one
frozen copy (an item holds the call's input, the reasoning state and the artifacts, which are the
run's own objects), and an item of a session the registry no longer knows is dropped, not refused as
an event is: nothing waits for an item, so one that cannot be told must not fail a run or leave its
tools running. Today's events and their ordering, `releaseResults` and `tool_batch` included, are
unchanged for as long as the stream and the hooks use them, which is also what keeps the workbook,
the demo and the replay as they are. A later change retires the old events when nothing reads
them.

### Stored channels from before

The contract has no compatibility reader: a one-time migration of a stored conversation, when it is
first opened, is how stored data moves (#437 is one for the layout; [Stored
data](../../../docs/shipping.md#stored-data) says a migration keeps the original until the new form
is written, through a temporary file renamed into place, keeping the file's modes). **A
conversation's channel logs are migrated the same way, once, when it is first opened by a release
that stores items, and as a unit.** A log without `format` is the earlier form. The transform
streams one channel at a time and is pure over the entries in order. Each old entry becomes:

- `text_delta`: adjacent entries of one message, with no other entry between, become message items
  of at most 8,192 code units each;
- `reasoning`: a reasoning item;
- `tool_result` or `task_running`: one tool call item **at the result's place** (a stored log has
  the items in the order they settled), built from the entry, which carries the call and its
  description; the `tool_call_started` entry it pairs with (the nearest before it with the same call
  id, the first unpaired one when a turn repeats an id, since ids repeat across turns) gives the
  item nothing but its `turn`, and is dropped. The `turn` is the `turn_end` that precedes the
  result, and the transform counts turns for an orphan. A start still unpaired when the next
  turn's first start, a `turn_end`, `run_started`, `done` or `closed` comes (a crash) becomes an
  `interrupted` item built from itself, so the starts waiting are those of one turn, each at most
  an entry;
- `event_omitted`: told by its `eventType`. A result or task stub that names its call becomes an
  omitted tool item with the header the stub holds (id and name, no description); a start stub whose
  result is real needs nothing, and one with no result is an `interrupted` item with that header;
  a stub that names no call (an id over the bound), a stub of a `text_delta` and one of a
  `reasoning` cannot be placed and are dropped, and the migration counts them;
- `tool_batch`: dropped, since a stored reader draws no parallel line;
- everything else (the lifecycle entries, `run_started`, `usage`, `turn_end` and the rest) passes
  through, so the new log is in the item form throughout, never both.

Cursors are numbered again, so **a child's `opened` entry, whose `spawnedAt` names a cursor of its
parent's channel (a sub-agent's, a command's or a service's), is rewritten through an old-to-new
map**, which is why the unit is the conversation and not the channel. An old cursor that does not
survive (a merged text entry, a dropped batch or start) maps to the first surviving entry at or
after it; a child whose `spawnedAt` names a cursor past the parent's end, of another kind or
malformed is left as it is and counted, since a stored log is not trusted. A new item gets the
writer's fit rule and header cuts, so one made from an entry that fitted is cut as the writer cuts
it, and does not make its channel unreadable. The map holds only the cursors the children name, found by reading
the children's `opened` entries first, and the transform keeps only the calls of one turn waiting
for a result, so its memory does not grow with the log. The migration writes every new log to a
temporary file whose name is not `*.jsonl` (the quota counts those), makes its marker exclusively,
syncs the files and the folder, keeps the originals under a folder of the conversation that the
channel quota does not count (until the conversation is deleted), renames the new logs into place,
and removes the marker last; a conversation found with the marker is redone from the originals. It
runs before the lost-channel repair of a reopen, in the one process that serves a conversation, and
storage gains the operations it needs (replace a channel's log, forget its index and its full
marker, read the originals back, and the same on the memory store and the store contract's fake),
since a channel log is append-only today. **A channel the transform cannot read is left in the
earlier form and counted in the migration's result, which the host announces as it announces a
channel the lost-channel repair could not close**; it does not stop the conversation from opening,
its children keep their `spawnedAt`, and the readers of layer 4 take that channel as it is. That
is why those readers stay: a deliberate exception to the contract's reading only of current data,
for a channel that could not be migrated. #437, which builds channels for conversations stored
before channels existed, writes items directly once this change has landed.

### The wire break

The wire model is marked as a wire-breaking change once ([the contract](contract.md#version)),
which covers this work: there is no second bump. The change of the channel entry is a stored-data
change, handled by the migration above.

## The change, in layers

Each layer is a pull request on `main` that builds and passes without the ones after it. A layer
that changes what is written comes after the layers that read it, so nothing in between breaks a
consumer.

1. **This note and the baseline.** Docs only. The "after" is the same recipe.
2. **The item schemas and the `live` frame** (`protocol`, `client`, `backend`). The `item` entry,
   the `ItemEvent` union, the omitted form, `format` on the `opened` entry and the `live` frame in
   the contract, regenerated, additive; the backend's frame encoding, and the client's progress and
   its last-cursor reading, pass `live` frames through without moving or dropping them. Nothing
   writes them yet.
3. **The loop emits items** (`loop`, `runtime`). The item boundaries derived from the order of the
   adapter's chunks, the registry's item feed (published synchronously, frozen copies, with the
   message context an event gets, no queue), the item-making sites, the tool item completing at
   settle (inside the tool's own finish, and awaited on the path that stops the tools and
   rethrows, so no item is published after `done`), minted ids and the stop reason of a tool. The
   channel writer does not hear items yet: that is layer 5, with the live frames, so nothing in
   this layer would use them. The event path and its order tests are untouched; new tests pin the
   items, and the derivation against the chunk order each provider's mapping really sends
   (Responses, Messages with thinking and a tool call, chat completions, a call the context window
   did not fit, and a stop or a failure that cuts a reply).
4. **Readers take items** (`client`, `terminal`). `followNode`, `watchTranscript`, the Renderer and
   the chat read the `item` entry and `live` frames as well as today's `event` entries, a channel
   being in one form or the other, never both (a reply in progress, a tool's card as its item, the
   live parallel line grouped by `turn`, and the card placer finding a call through the item's
   `callId`, with the run's end releasing a card whose item has none). Nothing writes items yet, so
   this changes nothing a user sees; the tests feed both forms.
5. **Live frames and the snapshot** (`runtime`, `host`, `backend`). The writer takes its form as an
   option (the item form or today's), reads `format` from the `opened` entry of a channel it
   resumes, and in the item form sends what is not stored through a new kind of channel event to the
   subscription, with an early-buffer rule that caps bytes as well as frames; the coalesced deltas,
   the snapshot on every start, the offset join and the gap rule. No channel is in the item form
   yet (nothing sets the option in production), so nothing a user sees changes, and the tests open
   one. It is two changes if it grows: the path, then the snapshot and the join.
6. **Channels store items** (`runtime`, `storage`, the backend's tests). A new channel is in the
   item form: the writer stores the `item` entry with `format`, stops storing the events the items
   replace, and the stored text window goes; a release refuses a newer `format`. Stored logs of the
   earlier form are still served, since readers take both. Live frames already work (layer 5), so
   the chat does not lose its streamed text. This is the change a stored conversation sees, and it
   brings the "after" measurement. The writer's item-form option is turned on here. An older
   release does not refuse the new form: its loose stored-entry schema accepts the `item` entry and
   its subscription then serves the channel as `failed`, so the refusal of a newer `format` binds
   only from here on.
7. **The migration** (`storage`, `host`, and the store interface in `core` with its memory fake and
   contract). The unit migration at first open, the replace operation, the originals and the
   report of a channel it left. Every readable log is then in the item form.
8. **Docs, and the dead code** (`protocol`, `loop`, `runtime`). The "Tool results arrive as tools
   finish" section of [the contract](contract.md) is replaced by the item lifecycle, the mapping and
   consumer docs say what is true, and what only the old channel path used goes. The loop's old
   events stay for the stream and the hooks.

## Left open

- Whether reasoning's opaque replay state is stored in the item or beside it. It is large for some
  models, and the Messages mapping's holds the whole reply's content, so storing it in the item
  copies the reply; layer 3, which makes the item, decides with the chunks in front of it.
- The name and place of the migrated logs' originals; layer 7 decides within the rule above.
- Retiring the loop's old events for the hooks and the extensions: a separate decision, once the
  stream is gone.

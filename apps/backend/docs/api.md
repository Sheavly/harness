# The API

How a UI in another process talks to the harness: over HTTP, to the conversations a
`Conversations` (`@sheavly/host`) keeps. The routes add nothing to what an in-process UI gets by
calling `Conversations` itself; they turn requests into calls and results into responses. They
live in `src/api/`, one handler per route of `API_ROUTES` (`@sheavly/protocol/api/`): the table
gives each its method, path and body schema, `ApiHandlers` makes a missing handler a type error,
and a test fails for any route the app doesn't serve. A UI calls them with `@sheavly/client`'s
client, built from the same table.

## Routes

Every route is under `/conversations`, `/stored-conversations` (the ones kept on disk, live or
not), one of the setup roots listed below, or is `/health` or `/handshake`. Every request carries
`Authorization: Bearer <token>`, except `GET /health` and `QUERY /handshake`, which answer
without one (the contract marks them `public`; every other route needs the token).

| Request                                                                       | Answer                                                                                                                                                                                                                                                                                    |
| ----------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `GET /health` (no token)                                                      | `{ status: 'ok', serverVersion, protocolVersion }`: that Sheavly runs here and the two versions it reports, nothing else                                                                                                                                                                  |
| `QUERY /handshake`, `{ nonce }` (no token)                                    | `{ protocolVersion, proof }`: the proof that the server holds the token and is this instance, for that nonce (see "The handshake" in the protocol's contract doc)                                                                                                                         |
| `GET /conversations`                                                          | `{ conversations }`: each live one, oldest first                                                                                                                                                                                                                                          |
| `POST /conversations`, `{ messages?, workspace?, profile?, model?, effort? }` | `201 { id }`: a new conversation, continuing `messages`, in `workspace` on `profile`, starting on `model` (an id or a name) and reasoning effort `effort` (`low`, `medium`, `high` or `extreme`); both for this conversation only, not remembered                                         |
| `GET /conversations/:id`                                                      | its run: workspace, models, trust, the permission mode, the working root                                                                                                                                                                                                                  |
| `PUT /conversations/:id/model`, `{ id }`                                      | `204`: one of its models, by id, from the next model call                                                                                                                                                                                                                                 |
| `POST /conversations/:id/prompts`                                             | `200 { status, node, messageId?, queued }` at once: the prompt `started` (with the `messageId` it became), or waits in the queue (`queued`, no message yet) while the conversation is busy; `node` is the agent whose channel carries the run ([commands to a node](#commands-to-a-node)) |
| `POST /conversations/:id/yield`                                               | `200 { accepted }`: the running prompt ends at its completion point, background work left running; false when idle or stopping                                                                                                                                                            |
| `GET /conversations/:id/queue`                                                | `{ queued }`: the lines waiting to start; kept across a restart, outside history, and never started by reopening                                                                                                                                                                          |
| `PUT /conversations/:id/queue`, `{ queued }`                                  | `204`: replaces the waiting lines whole; they start in their new order                                                                                                                                                                                                                    |
| `QUERY /conversations/:id/stream`                                             | every entry, as SSE, while the client stays                                                                                                                                                                                                                                               |
| `QUERY /conversations/:id/subscribe`, `{ subscriptions, approvals? }`         | channels (a node's, or the tree's or usage's), as SSE: the stored history each position asks for, then what is stored next ([following channels](#following-channels))                                                                                                                    |
| `GET /conversations/:id/tree`                                                 | the tree as it stands: every node, ended ones included, every approval waiting, and the cursor to follow the tree channel from ([the tree](#the-tree))                                                                                                                                    |
| `GET /conversations/:id/usage`                                                | what the conversation has used: the total of every model call and each node's own, with the cursor to follow the usage channel from ([usage](#usage))                                                                                                                                     |
| `POST /conversations/:id/stop`                                                | `204`: the running prompt stops; history stays valid                                                                                                                                                                                                                                      |
| `POST /conversations/:id/nodes/:node/cancel`                                  | `204`: the node is cancelled, whatever its kind, and has exited ([commands to a node](#commands-to-a-node))                                                                                                                                                                               |
| `POST /conversations/:id/nodes/:node/messages`, `{ text }`                    | `204`: the main agent is sent the text as the user, at its next model call ([commands to a node](#commands-to-a-node))                                                                                                                                                                    |
| `POST /conversations/:id/approvals/:approval`                                 | `204`: the waiting approval is answered                                                                                                                                                                                                                                                   |
| `GET /conversations/:id/messages`                                             | `{ messages }`: the history, valid to continue from                                                                                                                                                                                                                                       |
| `QUERY /conversations/:id/skills`, `{ search? }`                              | `{ skills }`: what a prompt can run, for a `/` menu                                                                                                                                                                                                                                       |
| `DELETE /conversations/:id`                                                   | `204`: its prompts, tasks and processes stop; it's gone                                                                                                                                                                                                                                   |
| `QUERY /stored-conversations`, `{ search?, workspace?, profile? }`            | `{ conversations }`: every folder's and profile's, or those a title matches or that belong to one                                                                                                                                                                                         |
| `POST /stored-conversations/:id/reopen`                                       | `{ id }`: a kept one is live again, from its history                                                                                                                                                                                                                                      |

### Setting the backend up

A first run has no profile, so `POST /conversations` answers `409 not_set_up` until a profile has a
model that can be used. A UI sets that up with these routes, and nothing in the user's folder needs
editing by hand. Every id is a lowercase UUID the client makes (`crypto.randomUUID()`), so a `PUT`
is safe to repeat; a name is a label for people. A profile is the user's setting (work, personal):
its models and keys are its own, and a conversation sees only its profile's.

| Request                                                                 | Answer                                                                          |
| ----------------------------------------------------------------------- | ------------------------------------------------------------------------------- |
| `GET /setup`                                                            | the home folder, profiles with models, the default and global terminal settings |
| `PUT /terminal-settings`, `{ reducedMotion?, bell? }`                   | `204`: replaces global terminal preferences                                     |
| `GET /adapters`                                                         | what each adapter takes, as JSON Schema, with its secrets marked                |
| `GET /setup/models`                                                     | model-first catalogue choices and their supported hosting routes                |
| `GET /profiles/:profile`                                                | one profile; `ready` says a conversation can start on it                        |
| `PUT /profiles/:profile`, `{ name }`                                    | `204`: made or renamed                                                          |
| `DELETE /profiles/:profile`                                             | `204`: gone with its models, keys and conversations                             |
| `PUT /default-profile`, `{ profile }`                                   | `204`: where nothing else is chosen                                             |
| `QUERY /workspace-profiles`, `{ workspace }`                            | `{ workspace, profile?, bound }`: what a folder runs on and why                 |
| `PUT /workspace-profiles`, `{ workspace, profile }`                     | `204`: the folder always runs on this profile                                   |
| `POST /workspace-profiles/unbind`, `{ workspace }`                      | `204`: the folder runs on the default again                                     |
| `QUERY /trusted-workspaces`, `{ search? }`                              | `{ workspaces }`: each trusted folder, when, and `trusted`, `changed` or `gone` |
| `POST /trusted-workspaces`, `{ workspace }`                             | `204`: its `.sheavly/` hooks run as they are now                                |
| `POST /trusted-workspaces/revoke`, `{ workspace }`                      | `204`: they stop running; also for a folder that is gone                        |
| `QUERY /permissions`, `{ workspace }`                                   | `{ workspace, mode, allow, builtIn }`: what `run_command` may do in the folder  |
| `PUT /permissions/mode`, `{ workspace, mode }`                          | `204`: `ask`, `always_ask` or `allow_all`, from the next command of every run   |
| `POST /permissions/allow`, `{ workspace, entry }`                       | `204`: the command runs without asking in that folder from now on               |
| `POST /permissions/revoke`, `{ workspace, entry }`                      | `204`: it asks again; one that was not allowed is fine                          |
| `QUERY /profiles/:profile/models`, `{ search? }`                        | `{ models }`: by name, adapter or provider-side model                           |
| `GET /profiles/:profile/models/:model`                                  | one model, its key state and whether it is `usable`                             |
| `PUT /profiles/:profile/models/:model`, `{ name, adapter, definition }` | `204`: checked by its adapter, never with a secret                              |
| `DELETE /profiles/:profile/models/:model`                               | `204`: the model and its key                                                    |
| `PUT /profiles/:profile/credentials/:model`, `{ secrets }`              | `204`: write-only, replaces the model's secrets                                 |
| `DELETE /profiles/:profile/credentials/:model`                          | `204`: forgets the secrets, keeps the model                                     |
| `POST /profiles/:profile/credentials/:model/check`                      | `{ status }`: one tiny call with the stored key                                 |

- **A key is write-only.** No route answers with one, and no error, log line or stored file other
  than the profile's credentials holds it. A model's `credential` is `missing`, `set` or
  `not_needed` (its adapter has no secret): never the value.
- **Access is handed out only on this machine.** A key, a grant of trust, and a looser permission
  are what make the backend run something on the caller's say-so. Listening on `127.0.0.1`, `::1`
  or `localhost` is fine; on any other address, the credential routes (set, forget and check),
  `POST /trusted-workspaces`, `POST /permissions/allow` and `PUT /permissions/mode` to anything but
  `always_ask` answer `403 forbidden`, so none crosses a network the backend can't vouch for.
  Taking access away (forgetting a key, revoking trust or a command, choosing `always_ask`) and
  looking are never refused. `SERVER_ALLOW_REMOTE_SETUP=true` allows it, which belongs only behind
  TLS.
- **A model is checked before it is stored.** Its adapter refuses fields it doesn't have and a
  key where a model's fields go (`422`, saying which field and never quoting a value).
- **Setup is model-first.** `GET /setup/models` returns `{ models }`, each with a display name,
  `identity` and supported `hosts`. A host names its registered adapter, editable defaults and
  fixed native-model fields. The app owns these suggestions; the provider registry has no model
  defaults. Routes are filtered by available adapters. Custom models can still use any registered
  adapter through the existing schema-based forms.
- **Azure routing follows the endpoint protocol.** The DeepSeek preset uses `azure-chat` for
  `/models/chat/completions` with plain-reasoning replay enabled. GPT Responses routes remain
  `azure-openai`, and Claude Messages routes remain `azure-anthropic`. Selecting a model does
  not make a Chat endpoint speak Responses.
- **Identity is separate from hosting.** The model API accepts optional `identity: { model,
family? }` alongside `name`, `adapter`, `definition` and `pricing`. It is kept outside adapter
  fields on disk and on reads. Known catalogue models reject incompatible adapters and mismatched
  native model IDs; Azure deployment names remain configurable. This is chosen identity, not a
  verified cloud inventory. A model's identity is optional.
- **Usage is reported, and cost is estimated.** `GET /conversations/:id` includes cumulative
  `usage` across all sessions, restored from the full saved stream on reopen. Each model call
  produces a `usage` event. Null token counts and unpriced calls are explicit.
  The model API also accepts optional `pricing` metadata: `input`, `output`, `cacheRead` and
  `cacheWrite`, all in USD per million tokens. It is not sent to the adapter. A conversation
  captures configured prices when its providers are built; saved cost estimates are never
  recalculated on resume. The backend does not fetch prices or claim these are invoices.
- **The agent is told how large a context it has, and a person chooses it.** The model API accepts
  an optional `contextWindow` (any positive number of tokens up to 10,000,000), kept outside the
  adapter's fields
  like `pricing`. Every UI offers the same two sizes to pick from, "300K" (300,000) and "1M"
  (1,000,000), rounded and not a provider's exact window (`CONTEXT_WINDOW_CHOICES` in the
  protocol); the backend itself takes any size, so a model can have a different default. A model
  that sets none gets 300K, since the backend can't know what a deployment or gateway really
  serves. The choice is for cost: it is what the agent paces itself by, not a limit on what the
  provider accepts or charges, so a larger context is used only if the work needs it. The GPT-6
  models price a prompt over 272K input tokens higher, which 300K does not avoid. Only a
  deployment that really has the 1M window should use it. The window is captured when the
  conversation's providers are built, follows the model switch, and goes on each `usage` event as
  `usage.contextWindow`, for a UI to show against the tokens. The agent's own line is never in the
  stream or the history: see the loop's [context usage](../../../packages/loop/docs/run.md#context-usage).
  Conversation details also include `contextUsage` (`used`, `window`, `throughSeq`): the latest
  main-session input plus output, the active provider's configured window and the snapshot's
  stream position. Unknown counts or windows are omitted, not zero. Resuming restores the count;
  switching models changes the window without summing earlier calls or sub-agents. `usage`
  remains the separate cumulative billing record.
- **Deleting a profile deletes its conversations.** There is no undo, so a UI should ask first.
- **Terminal preferences are global to the user.** `GET /setup` returns `terminal` when stored
  in `config.json`. `PUT /terminal-settings`, `{ reducedMotion?, bell? }`, replaces those preferences
  and answers `204`. It requires the usual bearer token and neither grants access nor changes a
  model or credential. Reads never write. The terminal reads the value from `GET /setup` when
  opening an interactive chat or its settings menu, and applies it to all profiles, including
  resumed conversations.
  Both fields are optional booleans; the bell is off by default.
- **A folder is named by its path**, in the body (a UI knows the path; the config keeps a hash of
  its real path, so a symlink or a trailing slash is the same folder). It is checked as a
  conversation's workspace is (see "Several conversations at once"), so a folder that couldn't be
  worked in can't be bound or trusted; only `revoke` takes a path that no longer exists.
- **A folder runs on** the profile it is bound to, else the default (`QUERY /workspace-profiles`
  says which: `bound`). A binding to a profile that was deleted counts as none.
- **A folder's permissions are the user's, not the repo's.** They are in `permissions/` in the
  user's folder, shared by every profile, and `run_command` reads them on every command, so
  `PUT /permissions/mode` and `POST /permissions/allow` apply to the conversations already running
  in that folder, and `GET /conversations/:id` reports the mode as it is now. `QUERY /permissions`
  lists the user's own entries (`allow`, which `revoke` can remove) apart from the read-only
  commands every folder has (`builtIn`, which it cannot). Asking about a folder writes nothing.
- **Trusting a folder makes its `.sheavly/` hooks run**, which is code from the repo, so it is the
  user's call and asks the same locality as a key. It trusts the hooks as they are now: a later
  change to `.sheavly/` makes the entry `changed` and the hooks stop until it is trusted again.
  The trust is kept outside every repo, so a repo can't trust itself.

Bodies are the protocol's schemas (`@sheavly/protocol/server/`), validated with the same objects a
client parses with. A prompt is `{ text }` (`/<name>` mentions run skills) or `{ parts }` (exactly
the skills picked), never both.

Methods follow what each request is. A read with no input is `GET`; a read with input is `QUERY`
(RFC 10008: safe, idempotent, with a body), never a query string: a filter, a search or a resume
point is a typed body (the stream's filter, the skills' search). Setting a value is `PUT` (the
model: sending it twice is the same as once); anything else that changes state is `POST` or
`DELETE`, so no client or proxy retries it on its own. Each route of `API_ROUTES` declares whether
it reads or changes, and its type allows only the methods that fit; adding one is "A route" in
`.agents/skills/sheavly/extending.md`.

`GET /conversations/:id` is what the backend reports about the run it built (the host knows
nothing of workspaces or models): a conversation that reports nothing answers `not_found`.

### Several conversations at once

One backend serves any number of conversations, each in its own folder on its own profile, and
several in one folder. A start says where (`workspace`, `profile`); what it leaves out is decided
once, then fixed for the conversation's life and kept with it:

- **`workspace`** is an absolute path to an existing folder (symlinks followed; the backend's own
  folder, `WORKSPACE_ROOT`, when omitted). It is refused (`422 bad_request`) when it is not
  absolute, not there, not a folder, the root of a file system, the home folder (the agent can
  change everything inside its workspace), or holds or sits inside the folder where profiles and
  keys are kept.
- **`profile`** is a profile's id. Left out, it is the profile the folder is bound to, else the
  default. An id no profile has is `422 bad_request`, and no profile at all is `409 not_set_up`.
- **Where it is kept.** Under `profiles/<profile>/workspaces/<folder>/conversations/<id>/`, so a
  profile's conversations of different folders never mix, and a restart finds every one of them.
  `GET /conversations/:id` and `QUERY /stored-conversations` say which folder and profile each
  belongs to, and the stored query filters by either.
- **Reopening** puts a conversation back in the folder and on the profile it was kept with, not
  where a new one would go now. A folder deleted since is refused (`422`) and the conversation is
  kept.
- **What several share.** The file locks (edits to one file by any of them take turns, whichever
  profile each runs on). Everything else is its own: models, keys, sessions, history, stream and
  what the agent has read (an edit needs a read by the same conversation).
- **What they don't share yet.** Two conversations editing one file can still work from different
  views of it: the locks keep each write whole, not the two agents agreed.

## Streams

Both SSE answers send the same frames: `event: entry`, `id: <seq>`, `data: <StreamEntry JSON>`.
`seq` counts the conversation's whole combined stream with no gaps, so a client knows when it
missed one.

- **A prompt is answered at once.** `POST /prompts` never holds the request open for a run: the
  prompt `started`, or it waits in the conversation's queue while a prompt, or a run the
  conversation started itself for finished work, goes. The conversation starts each waiting line
  when what runs has ended, after the model has finished when the run waits on `await_tasks`
  (flow rules 3 and 4), and reads the run itself, so it runs whoever is connected. A client follows
  `QUERY /stream`, opened before it sends, for what the prompt does: a `queue` entry
  (`prompt_started`) comes before the run's events, and the main session's `done` ends it.
  `@sheavly/client`'s `promptEntries` does this for a script. A `parts` prompt, a line over 20,000
  characters or a 101st line to a busy conversation is refused with `409 cannot_queue`.
- `QUERY /stream` follows the whole conversation: every prompt, sub-agents, approvals and
  background tasks starting and ending (`kind: 'task'`, under the session whose tool started
  one). Its body filters it (`session`, with `subtree` the session's sub-agents too) and `replay`
  sends it from the start first. `Last-Event-ID: <seq>` resumes right after the last entry a
  client got.
- **A head frame.** A live stream that starts from now (no `replay`, no `Last-Event-ID`) opens with
  one frame that has an `id` and nothing else: `id: <seq>\n\n`, the `seq` of the last entry made
  before it opened. It announces no entry (SSE sets the last event id from it), and a reader that
  skips frames without an `event` ignores it. A client that has received no entry when its
  connection drops resumes after it, so what was made meanwhile is not missed, once the head has
  reached it: a drop before the head arrives still reopens with no id. A conversation with no
  entry yet sends none (a started one always has `session_started`).
- **A slow consumer is cut off, not buffered for.** A stream holds at most 1000 entries a client
  has not read yet (`SSE_QUEUE_LIMIT`). One that falls further behind ends, with what was queued
  dropped, and the client resumes after the last entry it got (`Last-Event-ID`), so nothing is
  lost and the server's memory per stream is bounded. `@sheavly/client`'s `reconnectingEntries`
  does this for a stream with no end of its own, such as `QUERY /stream` (`endless`), where an end
  can only be a cut: the prompt keeps running, and the client reads the rest with
  `Last-Event-ID`. The bound counts live entries only; a replay of history is sent whole. Without
  a store, a resume reaches back only as far as the entries kept in memory (`ENTRY_TAIL_SIZE`);
  this backend always has one.
- A `done` in the stream carries no history; `GET /messages` has it.
- A quiet stream gets a `: heartbeat` comment every 15 seconds, and `X-Accel-Buffering: no`, so a
  proxy in between neither closes nor buffers it.

A client leaving ends its stream, never the prompt: a prompt runs to its end, and `POST /stop`
stops one. Closing the conversation (`DELETE`), or `serve.ts` calling `conversations.closeAll()`
when it stops, stops its prompts, tasks and processes.

## Following channels

`QUERY /conversations/:id/subscribe` follows the channels the server keeps beside the
conversation's stream, one log per node (the main agent's, each sub-agent's, a command's, a
service's) and the conversation's own channels, its tree and its usage, as the
[wire model](../../../packages/protocol/docs/wire-model.md) describes them. The body is
`{ subscriptions: [{ channel, from }] }`: `channel` is a node's id, or `tree` or `usage`, and `from`
is `start`, `now`, `tail:<n>` (the last `n` entries of an agent's channel, the last `n` bytes of a
command's output), a cursor the client was given (what follows it) or, for the conversation's own
channels only, `snapshot`.

```bash
curl -N -X QUERY "$URL/conversations/$ID/subscribe" \
  -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
  -d '{"subscriptions":[{"channel":"<a node id>","from":"start"}]}'
```

It answers server-sent events: the stored history each position asks for, then each entry stored
after, in order, with none missed and none sent twice. A frame is one JSON `data` under one event
name, and has no `id`: one id cannot carry the cursors of several channels, so a client keeps each
channel's last cursor and sends them again as `from` when it reconnects.

- **`entry`**: an entry of a channel: `opened`, an agent's `updated` (the node as it is now) and its
  loop events (see below), a command's `output` (see below) and `closed`; on the tree channel, what
  it holds (`node_opened`, `approval_requested`, `queue_changed`, …).
- **`snapshot`**: for `from: snapshot` on the tree channel or the usage channel, its view as it
  stands (the tree, or the usage), first, with the cursor of the entry it covers up to; the entries
  after that cursor follow as `entry` frames.
- **`head`**: a channel asked from `now` opens with where it stands, the cursor of its newest entry,
  so a client that hears nothing before the connection drops can still resume after it.
- **`end`**: one channel is over, and no more frames of it follow: `completed` (its `closed` entry
  was sent), `cut_off` (the client did not keep up with that channel, or the conversation's
  subscriptions hold as much as they may, and the client resumes after the `cursor` the frame
  carries) or `failed` (no more entries will come: storing the channel failed, or no writer has
  it). The other channels go on, and the stream ends after the last one. A conversation that closes
  ends its channels with their `closed` entries, which the client reads like any other.

What it serves is the channels the conversation stores: an agent's, a command's or a service's
(which carries its output between its `opened` and `closed` entries, see below) and the tree's. A
channel the conversation does not have is `not_found`: another
conversation's node, an unknown id, and the tree of a conversation that keeps none are all one
`404` with one message, so a request learns nothing about channels it cannot reach.

A request that claims to answer approvals (`approvals: true`, which needs the tree channel, where an
approval is seen) counts as someone who answers them for as long as its connection is open: a tool
that asks while one is connected waits for an answer, and with none connected the approval is
refused at once (see [Approvals](#approvals)). The claim counts from the moment the request is
accepted, before its history is read, and is given back whichever way the connection ends: the
client leaves, a refusal (`not_found`, a position, `too_many_subscriptions`) or a read that fails.
It is a claim, not a check: any token holder may make it. Answer with
`POST /conversations/:id/approvals/:approval`. A conversation that closes ends the tree channel's
subscriptions as `failed` (its writer stopped; the channel is not closed, and a reopen goes on from
it).

## An agent's run

An agent's channel holds its run: each loop event its session sends is an `event` entry (the event
as the conversation's stream carries it, with its own `seq` and the `messageId` of the prompt it
answers), in the order they happened and numbered with the node's own `updated` entries, so one
subscription to the node's id is enough to show what it did. The main agent's channel also says
where each run began and holds every run it ran, the runs its sub-agents' reports woke included: it
reads `run_started`, the run's events, `done`, and again for the next run. A sub-agent's channel is
its own run only, with no `run_started`, and ends with the run's `done` and then its `closed`.
`run_started` says why the run started (`cause`: `prompt`, a user's prompt sent directly or started
from the queue, or `wake`, the run the conversation starts itself to deliver finished background
work) and the user message it answers (`messageId`; for a wake, the prompt's it goes on from). A
`prompt`'s entry also holds the prompt's `text` as the user wrote it: at most 20,000 characters, and
shorter when its JSON would not fit a stored entry, so it can be a shorter prefix than the tree's
`prompt_started` holds; a `wake` has none. The text is the user's and is untrusted like any text on
a channel. A conversation that keeps no channels writes none, and a wake with no message to name yet
(a reopened conversation's first run before any prompt) writes none. A `task_running` event names the node a tool started
(`nodeId`), so a client joins a tool call to the channel of the sub-agent or command it launched.

```bash
curl -N -X QUERY "$URL/conversations/$ID/subscribe" \
  -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
  -d '{"subscriptions":[{"channel":"<the main agent’s node id>","from":"tail:50"}]}'
# data: {"cursor":"s6","channel":…,"type":"event","event":{"seq":4,"type":"text_delta","text":"Understood."},"messageId":…}
```

- **Streamed text is merged.** The `text_delta` events of a session that come within 50 ms are one
  entry: the first delta's, with all their text and `lastSeq`, the `seq` of the last one in it, so a
  client that follows a session by `seq` knows what it has. A merged entry holds at most 8,192
  characters of text.
- **An event too large to store** (an entry is at most 64 KiB of JSON) is an `event_omitted` entry
  in its place: its type, its `seq` and its size, never its content. The conversation's stream still
  has it whole.
- **The conversation's own notices are not here**: a storage failure and an extension's own event
  are on the tree channel, and an approval, a queue change and a node's lifecycle too.
- **A run costs about what it costs on the stream**: about the same bytes (the merged text is
  smaller, the entry's envelope a little larger; a test holds it to less than a quarter above, and
  a real run of four prompts measured within a tenth below). Reading it is bounded like any channel:
  a read that would send more than 8 MiB of stored history is refused as `400`, whether it asks
  from `start`, from a cursor or for a `tail` (a tail may be up to 1,000 entries of up to 64 KiB),
  so ask from a cursor near the end or for a smaller tail.
- **A channel that could not be written** (its quota, a disk that failed, an event JSON cannot
  carry) ends as `failed` at the last entry stored, and the run goes on; the stream has all of it.

## A command's output

A command's or a service's complete output is the channel of its node. Subscribe to the node's id
(the tree lists it, with the command) and read `output` entries between `opened` and `closed`:

```bash
curl -N -X QUERY "$URL/conversations/$ID/subscribe" \
  -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
  -d '{"subscriptions":[{"channel":"<a command node id>","from":"start"}]}'
# event: entry   data: {"type":"opened","cursor":"b0","node":{"kind":"command",…},…}
# event: entry   data: {"type":"output","offset":0,"text":"building\n","cursor":"b9",…}
# event: entry   data: {"type":"closed","state":"completed","exitCode":0,"cursor":"b9",
#                       "output":{"status":"complete"},…}
# event: end     data: {"type":"end","channel":"…","reason":"completed","cursor":"b9"}
```

- **An entry is text.** `text` is UTF-8 in a JSON string, at most 16 KiB of bytes, cut between
  characters, so no character is split across two entries and nothing needs decoding (no base64).
  `offset` is the byte offset of its first byte and `cursor` the offset after it, so the next entry
  starts where this one ended and a client that keeps the last cursor sends it back as `from` to
  get the bytes after it, never `opened` again. `at` is not when a byte was printed, which is not
  recorded: live, it is when the first bytes of the entry were stored, and for the history of a
  command that has ended, when it ended.
- **Positions.** `start` is all of it, `tail:<n>` the last `n` bytes, `now` only what comes (with a
  `head` frame at the size it stands), and `b<n>` the bytes from `n`; `n` past the end is
  `422 cursor_out_of_range`. A read of more than one request may hold (8 MiB of JSON, with its
  other channels) is refused as `400`: for `start`, and for a cursor more than about 8 MiB behind
  the end. It is refused before anything is read when even the cheapest text (three bytes to a
  character of JSON) would not fit, and otherwise after reading up to the budget, which is given
  back. Output history is not paged, so a log larger than that cannot
  be read in full through this route yet: ask from a cursor nearer the end, or a tail, which
  skips what is before it.
- **It streams.** What the command prints is sent as it is stored, batched for at most 100 ms (a
  command that prints a character at a time is not a frame for each). A client that does not keep
  up is cut off (`end` with `cut_off`, after which no frame of the channel follows) and resumes
  from the `cursor` the frame carries, which reads the rest from the store with no byte missed or
  repeated, as long as what is left fits one request (see above). Every subscriber does its own
  encoding of what a command prints: 64 subscriptions to one command that prints fast are about 64
  times the work of one.
- **How it ended.** `closed` comes after all of the output, at its end, with the exit code and
  `output: { status }`: `complete`, or `incomplete` with a `reason` when something was lost (the
  log reached its size limit, a write failed): what was served is then a prefix, never presented
  as all of it. A command the server stopped under is `closed` as `lost`, at the end of what it
  printed. A command whose output was not stored has no `output` entries.

**Command output may contain secrets.** A command prints whatever it prints (an environment, a
credentials file, a token in a URL), and this serves all of it, not the bounded preview the
conversation's stream carries. The server does not look for secrets and does not redact. For now
any holder of the token reads it for a command in any conversation the server keeps, whichever
profile it runs on (profiles are not a boundary between token holders). Show it as untrusted
terminal text: it holds whatever escape sequence the command wrote, so a front end escapes it (the
terminal's `plainTerminalText`) and never passes it to a screen as it is.

## Commands to a node

A command is addressed by the node in the path, which a client gets from the tree, from the
`node` of a prompt's answer (the main agent) and from a channel it follows. What a command did
arrives on the node's channel and the tree.

```bash
curl -X POST "$URL/conversations/$ID/nodes/$NODE/cancel" -H "Authorization: Bearer $TOKEN"
curl -X POST "$URL/conversations/$ID/nodes/$NODE/messages" -H "Authorization: Bearer $TOKEN" \
  -H 'Content-Type: application/json' -d '{"text":"look at the tests first"}'
```

- **Cancel** answers `204`. A command or a service is killed and a sub-agent stopped, as the
  agents' `cancel_task` does, and the request waits until the process has exited, **for at most 10
  seconds**: a process that cannot be killed (one that left its process group and holds its output
  open) never ends its task, and the answer is then that the kill was sent; the node's channel says
  when it ended. The main agent is only signalled, as `POST /stop` does (its prompt ends soon after,
  with its history valid), and with no prompt running that does nothing. A kind nothing can cancel
  (an extension's) is `400 bad_request`. The agent that started a command or a sub-agent is **not
  told** that it was cancelled: no notice is queued, as for any cancel, so it learns from the
  node's end on the tree.
- **A message** is `{ text }` (one to 20,000 characters), answered `204`. It reaches the **main
  agent** as the user's, at its next model call, or at its next prompt when it is idle. An inbox
  holds up to 100 messages and 400,000 characters together until the agent takes them: past that a
  message is `409 cannot_queue`. A retry helps once the agent has taken them, which a running agent
  does at its next model call and an idle one only at its next prompt, so a client that fills an
  idle agent's inbox stays refused until the user sends one. A sub-agent is `400 bad_request`: it
  is messaged only by the agent that started it, so the user cannot steer one through the API yet.
  A command, a service and an extension's node are no agent (`400`).
- **A node that has ended** is `409 node_ended`, including one a conversation has already released
  (it does so soon after a finished command's end is reported). **After a restart and a reopen,
  the nodes of the first life are history**: the tree still lists them (the main agent as `lost`,
  an ended command as it ended), but a command to one is `404 not_found`, and the live main agent
  has a new node, which the tree and the answer of a prompt give. A node the conversation does not
  have is `404 not_found`: one that never was, one of another conversation, and an id that is not a
  node id's shape, all with one message, so a request learns nothing about a node it cannot reach.
  Whether it exists is decided before whether it has ended.
- **Who may send them**: any token holder, to any node of any conversation the server keeps, as it
  may read their output (see the Security notes): there is no scope yet.

## The tree

`GET /conversations/:id/tree` answers what a sidebar, a conversations list or a notification needs
without subscribing to every node: the tree as it stands (`TreeSnapshot`), with the `cursor` of the
tree channel's last entry it covers.

```bash
curl "$URL/conversations/$ID/tree" -H "Authorization: Bearer $TOKEN"
# { "channel": "tree", "type": "snapshot", "cursor": "s7", "at": …,
#   "nodes": [ { "kind": "agent", "id": …, "state": "idle", … }, { "kind": "service", … } ],
#   "approvals": [ { "node": …, "request": { "id": …, "command": "git push", … } } ] }
```

It holds every node, with its owner (`parent`), kind, state and times, ended ones included, and each
approval still waiting with the node that asked, so a client that connects late sees a service that
runs on and an approval that waits. A client starts from it and follows from its cursor, with
`from: <cursor>` or in one request with `from: snapshot`, and ends with what one that replayed the
whole channel from the start has: both are the same fold of the same entries. It is a view, not an
entry of the channel.

The tree channel holds, besides the nodes' lifecycle (`node_opened`, `node_updated`, `node_closed`)
and the approvals asked for and answered or given up, the conversation's own notices: its queue, a
queued line starting with the message it became (`prompt_started`), a line refused, and a storage
failure. The fields of an entry with no bound of their own near what a store keeps are cut so the
entry is 16 KiB of JSON or less: an approval's command, concerns, tool name and call id (the call id
to 200 characters), a command's command, output, description, reason and error, and the message of
an answer. An approval's command is the
whole command when it fits, so a read-only subscriber sees what would run; one that does not is cut,
its first concern says so, and the request then offers only to skip it (no run, no grant), so a
client that follows the options the tree gives is never offered to approve a text it was not shown
whole. (The approval itself is answered by its id, as ever, and the server accepts any answer the
request it holds allows: the tree is a view, not a gate.) The full command is on the conversation's
stream. An output keeps its end, a message ends in `…`. A snapshot at its bounds (1,000 nodes, and as
many approvals waiting; the oldest ended node nothing hangs from is dropped past that) is about 32
million characters of JSON: about 32 MiB of ASCII, up to three times that in bytes for text of
wide characters, and a held `GET /tree` response costs the server several times its size in memory
while it is sent (about 140 MiB for the widest). The tree channel has the same 4 GiB quota as any
channel, counted in bytes, and shares the conversation's 32 GiB with the node channels, so a client
that changes the queue some hundred thousand times with long lines fills it: the tree then stops being
written and is answered `507`, as below, for as long as the conversation lives. A snapshot taken (`from: snapshot`) is held in memory
by the server and counts against what the conversation's subscriptions may hold (128 MiB), not
against the 8 MiB of stored history a request may read. `GET /tree` is built and sent whole and is
not counted against that pool, like `GET /messages`: a token holder that asks for it many times at
once costs the server that much memory each.

It is `404` for a conversation that is not live (or closed) or whose host keeps nothing, and `507`
when the tree channel could not be stored (a stored channel that a reopen could not go on from, or a
write that failed at any point): a tree that stopped being written would stand still while the
conversation went on, so it is refused rather than served as if it were current.

A request is refused before the stream opens, with the status of any other route's failure (below):
a position the channel cannot be asked for, or a cursor it does not hold, or a conversation that
already serves 64 subscriptions. It reads at most 8 MiB of stored history for the whole request and
refuses a request for more, never cutting it: subscribe from a cursor or a tail. What a
conversation's subscriptions hold for clients that have not read it is bounded too, 128 MiB of JSON
(the heap is up to about twice that) all together, counted from the moment the history is being
read; what a paused read is told meanwhile is not counted, only bounded to 1,000 events a channel.
History that does not fit is refused as `too_many_subscriptions`, and a channel with more
than 1,000 live frames waiting, or whose next frame does not fit, is cut off on that channel only. A
client leaving frees its place at once, also while its history is still being read, which stops. A
quiet stream gets the same `: heartbeat` comment and `X-Accel-Buffering: no` as the conversation's
stream.

## Usage

`GET /conversations/:id/usage` answers what the conversation's model calls have used, per node and
in total (`UsageSnapshot`), with the `cursor` of the usage channel's last entry it covers. The
backend counts it, once, from the loop's `usage` events; a client asks, or follows the channel, and
counts nothing.

```bash
curl "$URL/conversations/$ID/usage" -H "Authorization: Bearer $TOKEN"
# { "channel": "usage", "type": "snapshot", "cursor": "s5", "at": …,
#   "total": { "calls": 6, "inputTokens": 41200, "outputTokens": 3100, "cacheReadTokens": 30800,
#              "cacheWriteTokens": 2400, "estimatedCostUsd": 0.31, "missingUsageCalls": 0,
#              "unpricedCalls": 0, "incomplete": false },
#   "nodes": [ { "node": …, "calls": 4, …, "context": { "used": 9800, "cached": 7200, "window": 200000 } },
#              { "node": …, "calls": 2, … } ] }
```

- **What it counts.** Each node's calls, its input, output, cache read and cache write tokens, its
  estimated cost, and the total of every node. The cost is the sum of what each call's usage event
  carries, which is the rate its model is configured with (`pricing`, USD per million tokens),
  captured when the call is made, so switching models never reprices an earlier call. It is an
  estimate from that rate, not a figure a provider billed. A call that reported tokens but had no
  price is in `unpricedCalls`, adding nothing to the cost; one that reported no tokens is in
  `missingUsageCalls`, never counted as zero usage. A provider's numbers are its own: tokens that
  are negative, not whole or more cached than sent count as tokens it did not report, a cost that
  is not a finite amount as no price. `incomplete` says the figures are a lower bound: a turn ended
  with no usage reported, or the conversation was kept before the usage channel existed.
- **How full the context is.** An agent's record has `context`: what its last call used, how much of
  that the prompt cache served and the window of the model it ran against. A call that wrote a
  summary is counted in the figures and is not the context.
- **Following it.** The usage channel is a channel of the conversation itself, like the tree: a client
  starts from the snapshot and follows after its cursor with `from: <cursor>`, or in one request
  with `QUERY /subscribe` and `from: snapshot` on the channel `usage`. An entry (`node_usage`) carries
  a node's figures and the total as they now are, not what was added, so a client replaces what it
  holds, an entry told twice does no harm, and the usage a snapshot and the entries after it give is
  the one the whole channel gives. A client never has to dedupe by a stream `seq`.
- **Across a restart.** The usage is stored (`channels/usage.jsonl` in the conversation's folder).
  A reopened conversation goes on from it: its first life's nodes keep their records, under the ids
  they were made under, and the total still covers them. A conversation kept before the channel
  existed opens it at its first reopen with its total `incomplete`: what it used before is not
  counted, and says so rather than read as zero. Calls made while a write was failing, or just
  before a crash, are not on the channel either.
- **Bounds.** A snapshot holds at most 1,000 nodes; past that the records of the oldest nodes that are
  not open are dropped (an entry that drops some says so, `evicted`), and their calls stay in the
  total. The usage channel has the same quotas as any channel and shares the conversation's 32 GiB;
  an entry is a few hundred bytes, one for each model call.

It is `404` for a conversation that is not live (or closed) or whose host keeps nothing, and `507`
when the usage channel could not be stored (a stored channel that a reopen could not go on from, or a
write that failed): usage that stopped being written would stand still while the conversation went
on, so it is refused rather than served as if it were current. A subscription to it is refused as
any other is (below).

## Several UIs on one conversation

An editor and an agent window can be views of one conversation. One starts it; the other finds it
with `GET /conversations` (each entry has its `id`, `title`, main `session`, whether it is
`running`, and `startedAt`) and opens its own `QUERY /stream`, with `replay` to catch up. Each
then sees every prompt either sends, live and in the same order. Either can send the next prompt:
one sent while another runs waits in the queue, which both see. Either can answer an approval: the
first answer counts, and a later one gets `unknown_approval`.

There is no way to send text to a running prompt: it waits in the queue, and the conversation asks
what runs to yield so the line starts once the model finishes its turn rather than after background
work. `POST /conversations/:id/yield` (no body) asks the same by itself: the running prompt ends as
`completed` at its completion point, background work keeps running and its results reach the next
prompt. A run held on `await_tasks` ignores the yield while its grouped tasks run, and is still
accepted; once they settle the run ends at its next completion point. It returns JSON
`{ accepted: true }`, or `{ accepted: false }` when the conversation is idle or its run is
stopping. Unknown ids return `404 not_found`.

## Approvals

An approval a tool asks for is an entry in the stream (`kind: 'approval'`), in order with the
events of the call that asked. A client answers with `POST /approvals/:approval`. A client that
will answer says so when it opens the stream (`QUERY /stream` with `approvals: true`), or the tree
channel's subscription (`QUERY /subscribe` with `approvals: true`, which shows each waiting approval
with the node that asked); while at least one such connection is open, a request waits for an
answer. With none open, it is refused at once, as in a headless run: a script that only sends prompts, or a UI that never answers, never
leaves a run waiting on an approval no one will give.

## Errors

Every failure is `{ error: { code, message } }` (`ServerError`):

| Status | Code                     | When                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| ------ | ------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 400    | `bad_request`            | a body that doesn't parse or is over 5 MB, or an approval answer its request didn't offer; a handshake body over 1 KB, or a nonce that is missing, shorter than 22 or longer than 86 characters, or not unpadded base64url (the message never repeats the nonce); a `QUERY /subscribe` for a position its channel cannot be asked for (a tail over 1,000 entries on an agent's channel or 65,536 bytes on a command's, a cursor of the other kind) or for more than 8 MiB of stored history, or a claim to answer approvals (`approvals: true`), which is not supported yet; a command to a node its kind cannot take (cancel an extension's node, message a command, a service or a sub-agent), or a message with no text or over 20,000 characters |
| 401    | `unauthorized`           | no token, or a wrong one, on any route but `GET /health` and `QUERY /handshake`; also an unknown path, an `OPTIONS` request and another method on those two paths                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| 403    | `forbidden`              | a request whose `Host` is not one of the server's names, or that carries an `Origin` the server does not list, on any route, before the token is looked at; also a setup that hands out access on a server that listens beyond this machine                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| 404    | `not_found`              | no such conversation (or route), or one already closed; for `QUERY /subscribe`, a channel the conversation does not have, whatever the reason; for `GET /tree` and `GET /usage`, a conversation whose host keeps no tree or no usage; for a command to a node, one the conversation never had, one of another conversation, or an id that is not a node's                                                                                                                                                                                                                                                                                                                                                                                            |
| 404    | `unknown_approval`       | no approval waiting with that id                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| 409    | `session_running`        | a prompt is still being prepared or running in that conversation, for a client that sends with `send` in-process                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| 409    | `cannot_queue`           | the conversation is busy and this prompt cannot wait: it picks skills as `parts`, it is over 20,000 characters, or 100 lines already wait; for a message to an agent, its inbox already holds 100 messages or 400,000 characters                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| 409    | `node_ended`             | a command to a node of the conversation that has ended (a released one too): nothing can be sent to it any more, which is not `not_found`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| 422    | `unknown_skill`          | `parts` picked a skill no one has                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| 422    | `unknown_model`          | `PUT /model` named an id the conversation hasn't                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| 422    | `cursor_out_of_range`    | `QUERY /subscribe` named a cursor the channel does not hold (or one past the end of a command's output); it is never clamped to the nearest, so ask again from `start` or a tail                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| 429    | `too_many_subscriptions` | the conversation already serves 64 subscriptions, or its subscriptions hold too much for the history asked for to fit; ask again when one has ended                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| 507    | `storage_failed`         | the conversation could not be stored, so it takes no more prompts rather than carry on unrecorded; for `GET /tree` and `GET /usage`, its tree or usage channel could not be stored; for `QUERY /subscribe`, a command's output could not be read                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| 500    | `internal`               | the server failed; the message never holds its details                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |

A prompt that can't start is answered with an error before its stream opens.

## Security

- `serve.ts` binds to `127.0.0.1` by default: the backend runs commands for whoever reaches it.
- The token is compared in constant time, sent only in a header (the stream is `QUERY` read with
  `fetch`, never `EventSource`, so it is never in a URL), and never logged.
- **The `Host` and `Origin` of a request are checked first**, before the public routes and before
  the token, so a web page whose name was made to resolve to this machine (DNS rebinding) cannot
  reach any route. The `Host` names a request may carry are `localhost`, `127.0.0.1` and `[::1]`
  always, the name the server is bound to unless that is a wildcard address, and those in
  `SERVER_ALLOWED_HOSTS` (comma-separated host names, for a server reached by its name; `0.0.0.0`
  is never one, since a page can reach a server through it). Only the name is compared, never the
  port: a port forwarded over SSH carries the port it forwards, not the server's. A request with
  any `Origin` is refused unless `SERVER_ALLOWED_ORIGINS` lists it (comma-separated origins such as
  `https://app.example`; none by default, and `Origin: null` never): the terminal, the editor
  extension and `curl` send none. Listing an origin only lifts that refusal: the server sends no
  CORS headers, so a listed page still cannot read an answer or send the token (a preflight is
  answered `401`), and the list is a step toward a browser front end, not one. A cross-site `GET`
  that carries no `Origin` (an image, a navigation) reaches only `GET /health` with a loopback
  `Host`, and cannot read the answer. The refusal is `403 forbidden` with a fixed message that repeats
  nothing the request sent. A `Host` that is not a name at all (a user name, a path) is refused too
  (the server's own request builder answers some of those `400` before the check is reached).
  `request-origin.utils.ts` holds the rules, and `host-origin-check.test.ts` sends a foreign `Host`
  and an `Origin` to a listening server over every route of `API_ROUTES`, so a route added later
  is covered, and a public one cannot be left outside the check.
- **Two routes answer without the token**, `GET /health` and `QUERY /handshake`, so a client can
  check what it found before it trusts it with the token. They reveal only that Sheavly runs on
  that address and its two versions (the backend's and the protocol's); health has exactly the keys
  `status`, `serverVersion` and `protocolVersion`, and no path, process id, home folder or
  conversation data. Their handlers receive no conversations, setup, workspaces or permissions.
  The handshake returns an HMAC of the client's nonce, the server's per-start instance id and the
  protocol version, keyed with the token: the token and the instance id are never in an answer.
  They are registered ahead of the token check and read at most 1 KB of body (the 5 MB limit
  applies only after it). There is no rate limit on them, they keep no state and nothing about
  them is logged, not the nonce nor the proof. A route is private unless the contract marks it
  `public`, and a test (`public-routes.test.ts`) pins the public set to these two.
- **Slow requests are cut off.** The two public routes read a body without a token, so a client
  that trickles one is unauthenticated work. `serve.ts` sets the server's `requestTimeout` to 30 s
  (the whole request, head and body; Node's default is 300 s) and `headersTimeout` to 10 s (the
  default is 60 s), and checks for expired connections every second (`configureServerTimeouts`).
  They bound the receiving of a request only, so a server-sent event stream, which is a response,
  stays open as long as it needs. The 30 second request timeout covers the whole request body,
  so a legitimate large prompt sent over a very slow link (about 2 MB at 70 KB/s or slower) is cut
  off with a 408 too: the limit protects against a stalled caller, and that is the trade-off.
  There is still no rate limit and no limit on the number of
  connections: a client that opens many connections, or many fast requests, is not stopped (only a
  conversation's subscriptions are counted: 64 at once).
- **A command's complete output is served to any token holder** (`QUERY /subscribe` on a command's
  node, see [a command's output](#a-commands-output)), and it may hold secrets: the server does not
  redact, and the token is not scoped to a profile or a conversation. That is why the `Host` and
  `Origin` check comes first and the token is never in a URL. A client shows it as untrusted
  terminal text.
- **A conversation's stream and an agent's channel serve everything the agent did, to any token
  holder** (`QUERY /stream`, and `QUERY /subscribe` on a node's id, see
  [an agent's run](#an-agents-run)): the model's text and its reasoning state, each tool call's input and
  result (file contents, command lines, a command's bounded output preview) and its sub-agents'
  runs. The server does not redact it beyond what the loop already redacts of an error, and the
  token is not scoped to a profile or a conversation. The channel is the stream's equal for
  confidentiality, and a client shows it as untrusted text.
- `internal` errors never carry their message: it can hold paths or a provider's reply. The
  backend logs each one once as `api.request_failed` (the route's pattern and status, and the
  error with its stack and cause chain, redacted by `@sheavly/logger`): to the conversation's
  `log.jsonl` when the route has a conversation id, else to `~/.sheavly/logs/backend.jsonl`, and
  as a JSON line to stderr. A prompt the conversation runs itself, one a send started
  or one from its queue, that fails with nobody awaiting it (`prompt.failed`), and a run it starts
  itself for finished work (`conversation.wake_run_failed`), are logged the same way. See [debugging](../../../.agents/skills/sheavly/debugging.md) for reading them with `jq`.

## Hosting it elsewhere

The API is built so it can move off localhost later: the bind address is a setting, the token is
only ever a header, a dropped stream resumes with `Last-Event-ID`, and the routes are web-standard
`Request`/`Response`. What hosting it for others still needs (TLS, users, a sandbox per
workspace) is still to come.

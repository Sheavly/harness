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

| Request                                                                       | Answer                                                                                                                                                                                                                                            |
| ----------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `GET /health` (no token)                                                      | `{ status: 'ok', serverVersion, protocolVersion }`: that Sheavly runs here and the two versions it reports, nothing else                                                                                                                          |
| `QUERY /handshake`, `{ nonce }` (no token)                                    | `{ protocolVersion, proof }`: the proof that the server holds the token and is this instance, for that nonce (see "The handshake" in the protocol's contract doc)                                                                                 |
| `GET /conversations`                                                          | `{ conversations }`: each live one, oldest first                                                                                                                                                                                                  |
| `POST /conversations`, `{ messages?, workspace?, profile?, model?, effort? }` | `201 { id }`: a new conversation, continuing `messages`, in `workspace` on `profile`, starting on `model` (an id or a name) and reasoning effort `effort` (`low`, `medium`, `high` or `extreme`); both for this conversation only, not remembered |
| `GET /conversations/:id`                                                      | its run: workspace, models, trust, the permission mode, the working root                                                                                                                                                                          |
| `PUT /conversations/:id/model`, `{ id }`                                      | `204`: one of its models, by id, from the next model call                                                                                                                                                                                         |
| `POST /conversations/:id/prompts`                                             | `200 { status, queued }` at once: the prompt `started`, or waits in the queue (`queued`) while the conversation is busy; its entries arrive on `QUERY /stream`                                                                                    |
| `POST /conversations/:id/yield`                                               | `200 { accepted }`: the running prompt ends at its completion point, background work left running; false when idle or stopping                                                                                                                    |
| `GET /conversations/:id/queue`                                                | `{ queued }`: the lines waiting to start; kept across a restart, outside history, and never started by reopening                                                                                                                                  |
| `PUT /conversations/:id/queue`, `{ queued }`                                  | `204`: replaces the waiting lines whole; they start in their new order                                                                                                                                                                            |
| `QUERY /conversations/:id/stream`                                             | every entry, as SSE, while the client stays                                                                                                                                                                                                       |
| `POST /conversations/:id/stop`                                                | `204`: the running prompt stops; history stays valid                                                                                                                                                                                              |
| `POST /conversations/:id/approvals/:approval`                                 | `204`: the waiting approval is answered                                                                                                                                                                                                           |
| `GET /conversations/:id/messages`                                             | `{ messages }`: the history, valid to continue from                                                                                                                                                                                               |
| `QUERY /conversations/:id/skills`, `{ search? }`                              | `{ skills }`: what a prompt can run, for a `/` menu                                                                                                                                                                                               |
| `DELETE /conversations/:id`                                                   | `204`: its prompts, tasks and processes stop; it's gone                                                                                                                                                                                           |
| `QUERY /stored-conversations`, `{ search?, workspace?, profile? }`            | `{ conversations }`: every folder's and profile's, or those a title matches or that belong to one                                                                                                                                                 |
| `POST /stored-conversations/:id/reopen`                                       | `{ id }`: a kept one is live again, from its history                                                                                                                                                                                              |

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
will answer says so when it opens the stream (`QUERY /stream` with `approvals: true`); while at
least one such stream is open, a request waits for an answer. With none open, it is refused at
once, as in a headless run: a script that only sends prompts, or a UI that never answers, never
leaves a run waiting on an approval no one will give.

## Errors

Every failure is `{ error: { code, message } }` (`ServerError`):

| Status | Code               | When                                                                                                                                                                                                                                                             |
| ------ | ------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 400    | `bad_request`      | a body that doesn't parse or is over 5 MB, or an approval answer its request didn't offer; a handshake body over 1 KB, or a nonce that is missing, shorter than 22 or longer than 86 characters, or not unpadded base64url (the message never repeats the nonce) |
| 401    | `unauthorized`     | no token, or a wrong one, on any route but `GET /health` and `QUERY /handshake`; also an unknown path, an `OPTIONS` request and another method on those two paths                                                                                                |
| 403    | `forbidden`        | a request whose `Host` is not one of the server's names, or that carries an `Origin` the server does not list, on any route, before the token is looked at; also a setup that hands out access on a server that listens beyond this machine                      |
| 404    | `not_found`        | no such conversation (or route), or one already closed                                                                                                                                                                                                           |
| 404    | `unknown_approval` | no approval waiting with that id                                                                                                                                                                                                                                 |
| 409    | `session_running`  | a prompt is still being prepared or running in that conversation, for a client that sends with `send` in-process                                                                                                                                                 |
| 409    | `cannot_queue`     | the conversation is busy and this prompt cannot wait: it picks skills as `parts`, it is over 20,000 characters, or 100 lines already wait                                                                                                                        |
| 422    | `unknown_skill`    | `parts` picked a skill no one has                                                                                                                                                                                                                                |
| 422    | `unknown_model`    | `PUT /model` named an id the conversation hasn't                                                                                                                                                                                                                 |
| 500    | `internal`         | the server failed; the message never holds its details                                                                                                                                                                                                           |

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
  connections: a client that opens many connections, or many fast requests, is not stopped.
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

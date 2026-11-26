# Design

How a UI calls the backend: one client built from the API's routes (`API_ROUTES`,
`@sheavly/protocol/api/`), the same table the backend's routes follow, so the two can't drift
apart without a type error. What each route does is [the backend's API](../../../apps/backend/docs/api.md).

## Calls

Each route is one call by name, its path params and body typed from the contract's schemas,
`QUERY` included:

```ts
const client = createClient({ url, token });
const { id } = await client.call('startConversation', { body: {} });
const { skills } = await client.call('querySkills', { id, body: { search: 'review' } });

for await (const entry of promptEntries({ client, id, prompt: { text: 'hi' } })) render(entry);
```

- `promptEntries` (`prompt/`): `POST /conversations/:id/prompts` is answered at once, the prompt
  started or queued, and its run's entries arrive on the conversation's stream. This follows that
  stream from before the send (`followConversation`) and yields from the prompt's
  `prompt_started` to its run's end, or throws `PromptRefusedError` for a queued prompt that could
  not start. A UI that shows every run, its own and the conversation's, follows the stream itself
  and sends with `call('sendPrompt')`.
- `call`: a route that answers JSON. The answer is parsed with the route's schema, so ids keep
  their brands, and one off the contract throws `AnswerError`.
- `send`: a route that answers nothing (`204`).
- `stream`: a route's server-sent events, as entries (`readEntries`: each `entry` frame parsed
  with `streamEntrySchema`, heartbeats skipped). `open` hands back the raw stream, to save.
- A refused request throws `RefusedError`, with the backend's `code` (`not_found`,
  `unknown_model`, …) to branch on. The client reads at most 4 KB of a private route's refusal
  too: a longer one is cancelled at the bound and the error keeps its status with a fixed message and
  no `code`.
- A public route's answer over 4 KB throws `AnswerTooLargeError`, and its redirect
  `RedirectedError`.

The token goes in a header on every request to a private route, never in a URL, and never on a
public route (`getHealth`, `queryHandshake`: the contract's `public: true`, read from
`API_ROUTES`). `fetch` can be passed in: a proxy, or a test's fake.

## Verifying a server

A token must not be sent to a server before it has shown it is the right one. `createPublicClient({ url, fetch? })`
(`client/`) is a client with no token: it takes only the public routes (a private route name is a
type error, and throws at run time), so it can never send one. `verifyServer({ url, token,
instanceId, fetch?, signal?, timeoutMs? })` uses it to ask `QUERY /handshake` with a fresh nonce
for every call, and checks the proof the server answers with, a HMAC only a holder of the token
and the instance id can make. The token is used to check the proof, and is in no request, result
or error. A client never sends the token to whatever answers at the URL, except to a process that
relays the handshake to the real server (see "The boundary" in `docs/shipping.md`): the proof
shows that the real server answered, not that nothing stands in between.

It answers one of:

- `{ status: 'verified', protocolVersion }`: the server proved it, on a compatible protocol.
- `{ status: 'version_mismatch', older, client, server, message }`: the server proved it, but
  speaks a protocol this client can't. `older` says which side to update; `message` says what to do.
- `{ status: 'wrong_server' }`: another token or instance, a replayed or made-up proof, an
  answer that is not the contract's, an answer over 4 KB (the client stops reading, cancels the
  body and goes no further) or a redirect (a public route is never redirected, so the verdict is
  about the address it was given). A server that does not prove it is told nothing about
  versions: the versions are compared only after the proof verifies.
- `{ status: 'no_handshake' }`: the route answered `404` or `401`: a server without the route, or
  something that is not Sheavly. It is not a verdict that the server is Sheavly: nginx, another
  app or an impostor answers `404` too, and an impostor chooses to.

Only `verified` and `version_mismatch` come from a server that proved it holds the token, so only
they may lead to sending the token. `no_handshake` and `wrong_server` never do.

A server that is not there (connection refused, an abort through `signal`) or that does not
answer within `timeoutMs` (5 s unless set) is not a verdict: `verifyServer` throws, as every call
of this package does, so the caller decides what that means (start a server, say). A refused
connection throws the transport's own error and a silent server throws `VerifyTimeoutError`: both
are a failure to reach a server, not an answer from one, so neither is `wrong_server`. The
caller's own abort is thrown as the transport threw it, not as a timeout. An empty `token` throws
`EmptyTokenError` before any request is made. The terminal will use the check before it sends the
token anywhere.

The routes the contract marks `public` read their answer through a bound (4096 bytes,
`PUBLIC_ANSWER_MAX_BYTES`) and never follow a redirect, whoever calls them: what listens on the address may be anything.
They ask with `redirect: 'manual'` and treat any redirect answer (a 3xx status or a browser's
`opaqueredirect`) as `RedirectedError`, so a redirect is `wrong_server` however the platform's
`fetch` words it; the answer's body is cancelled unread. A private route keeps `fetch`'s redirect default;
undici drops `Authorization` when a redirect leaves the origin.

## Approvals

An approval names the session that asked by id only (the stream entry's `sessionId`); a
sub-agent's title, depth and parent live in the `session_*` updates, the one place they are
kept. `watchApprovals` (`approvals/`) opens the stream as one that answers approvals, replays it
from the start so sub-agents already running are known, and calls `onApproval` with a
`HeardApproval`: the `update`, the `sessionId`, and `agent` (that sub-agent's last snapshot) when
a sub-agent asked. The id is always there; whether and how to show `agent` is the UI's choice.
`followApprovals` does the same over any stream of entries. A replay also re-sends approvals
already answered, each followed by its answer, so key a UI by the approval's id.

`watchTreeApprovals` reads them from the tree channel instead, see [Subscriptions](#subscriptions);
it is what the terminal's chat and workbook use.

## Reconnecting

The backend resumes a stream after the `Last-Event-ID` it is given, so a dropped connection loses
nothing. `reconnectingEntries` (`client/`) does it for a UI: it takes an `open` that opens the
stream after a `lastEventId`, yields each entry once and in order (an entry at or before the last
one seen is skipped), and on a drop waits (250 ms, doubling to 5 s) and opens again. A stream
that ends cleanly ends it (unless it is `endless`, a conversation's whole stream, which only the
client leaves: its end is a cut by the backend, a slow consumer, and so a drop), and so does the
`signal`. When the attempts in a row, with no entry arriving and no connection staying up for 30
s between them, have failed for an hour (`RECONNECT_BUDGET_MS`, or `ReconnectPolicy.budgetMs`; the
count of `attempts` is the other way to bound it), it throws `StreamLostError`, with the
`lastEventId` it reached and the `cause`, so a UI can show that it lost the stream instead of
guessing. The hour is read from `performance.now()`, which on Linux and macOS stops while the
machine sleeps: a stream followed across a sleep, however long, is opened again on waking, and the
time asleep is not spent. A refusal (4xx) or an entry off the
contract is not retried. `watchApprovals` uses it. While the stream is down nobody listens for
approvals, so a request made then is refused, not held.

A live stream (no `replay`, no `Last-Event-ID`) opens with a head frame, an `id` and nothing else:
the `seq` of the last entry made before it opened. `readFrames` gives it (`readEntries` skips it),
and `reconnectingEntries` resumes after it when no entry had arrived yet, so a drop before the
first entry misses nothing made meanwhile, once the head has arrived (a drop before even that
reopens with no id). A conversation with no entry yet sends none, which a started conversation
never is (it has its `session_started`).

A prompt's run is read from the conversation's stream too (`promptEntries`), so a cut stream is
reopened after the last entry heard and the run's `done` still arrives. A line a client takes out
of the queue (`PUT /queue`) gets no `prompt_refused`: `promptEntries` for it waits until its signal
aborts.

`answerWhileWaiting` (`approvals/`) wraps a call to `answerApproval` and treats `unknown_approval`
(answered elsewhere, or its call was interrupted) as done: the one place that rule lives.

## Subscriptions

A conversation's channels are read through `QUERY /subscribe`: the tree channel (what exists and what
waits for the user) and one channel for each node a UI shows. The server keeps no state for a
connection, so the client keeps each channel's cursor and sends them again when it opens again.

```ts
const stop = new AbortController();
const watch = await watchTree({ client, id, onChange: render, signal: stop.signal });
const entries = await followNode({ client, id, node, from: 'tail:200', signal: stop.signal });

for await (const entry of entries) show(entry);

// Commands are typed calls of the contract's routes, no wrapper:
await client.send('cancelNode', { id, node });
await client.send('messageNode', { id, node, body: { text: 'look at the tests first' } });
const sent = await client.call('sendPrompt', { id, body: { text: 'hi' } }); // PromptSent
```

- `subscribeChannels({ client, id, subscriptions, approvals?, signal })` (`client/`) is the base:
  the frames of the channels, each once. Entries and `head` and `snapshot` frames are given as they
  came; a channel that ended `completed` or `failed` ends with an `end` frame, and the generator
  ends when every channel has. It resolves once the server accepted the first connection.
- **Resuming.** A dropped connection is opened again with each channel that has not ended asked
  from the cursor of its last frame (a channel with no frame yet is asked as it was first asked, so a
  drop before the `head` of a `now` subscription reopens at `now`), so nothing is missed and
  nothing comes twice: a frame at or before a channel's last cursor is dropped, except a command's
  `closed` entry, whose cursor is that of the output before it. The wait, the budget and the
  `StreamLostError` are those of `reconnectingEntries` (`ClientOptions.reconnect`). A channel the
  server cut off because the reader did not keep up (`end` with `cut_off`) is left and asked for
  again from its cursor, and counts as a failed attempt when nothing came of it, so it cannot loop for ever.
  A refusal (a 4xx, `cursor_out_of_range` included) and an entry off the contract are thrown, since
  asking again gets the same answer: the caller asks from somewhere else. The one refusal that is
  asked again is `429` (`too_many_subscriptions`: the server serves as many as it may and says to
  ask again when one has ended, which a client that leaves one connection and opens another meets
  for a moment), once the first connection is open; the first connection's refusal is thrown at once.
  A server that cuts a channel off after every frame it sends is reconnected to with a wait each time
  and never reaches the budget, since a frame that arrives starts the count again: the same as the
  conversation stream's reconnect.
- **Bounded.** The reader is pulled, and holds the frame being read (and the frames one chunk of the
  transport completes), in pieces joined a thousand at a time so that its size is about its
  characters however the server cuts it into chunks (3,000,000 one-character chunks of a frame held
  about 3 MiB). A frame past `MAX_SUBSCRIBE_FRAME_CHARS` (64 MiB; the tree's snapshot at its bounds
  is about 32 MiB) throws `AnswerTooLargeError` and is not retried; the bound is checked after each
  chunk, so a frame may pass it by one. A slow reader is cut off by the server and resumed, never
  buffered for. The conversation stream's reader (`readEntries`) has no such bound and is not used
  for subscriptions. A tree that grows past what a snapshot may hold (more than 1,000 nodes, or
  more than 1,000 waiting approvals) is off the contract and is refused (`AnswerError`), not kept:
  the protocol's rule drops only an ended node nothing hangs from, so open nodes and the parents of
  kept ones would pile up without end, and each entry costs a pass over them all.
- `watchTree({ client, id, approvals?, onChange, signal })` (`tree/`) keeps the tree: the snapshot,
  then each entry folded in with the protocol's one rule (`applyTreeEntry`). `tree()` is what it is
  now and `onChange` is told of each change, not of an entry that changes nothing in it. After a
  reconnect the tree equals the snapshot of that moment; when the server no longer holds the position
  (`cursor_out_of_range`) it asks again from `snapshot`, which replaces the tree. `ended` resolves
  when the tree channel ends `completed` and when the signal aborts, and rejects with
  `ChannelFailedError` when the channel ends `failed` (storing it failed, or its conversation closed:
  nothing more will come and the claim to answer approvals is gone), with a refusal, with
  `AnswerError` for a tree off the contract, and with whatever `onChange` throws. It starts at once,
  so attach a handler to `ended` (a rejection nobody handles is an unhandled rejection).
- `followNode({ client, id, node, from?, signal })` (`nodes/`) reads one node's channel to its
  `closed` entry: an agent's `updated` entries, a command's or a service's output in pieces at byte
  offsets. It throws `ChannelFailedError` when the channel ended `failed`, since what was read is not
  all of it.
- `watchTreeApprovals({ client, id, onApproval, onGone?, signal })` (`approvals/`) follows the tree
  as one that answers approvals, so a tool that asks waits for the user instead of being refused, and
  tells of each approval once with the node that asked (`TreeApproval`), and when it no longer waits.
  It resolves once the server accepted the connection, which is when the claim counts: send the
  first prompt after it. While the connection is down nobody listens, and a request made then is
  refused. It replaces `watchApprovals`, which reads the whole stream and goes with it.
- The old whole-stream readers (`followConversation`, `promptEntries`, `watchApprovals`) stay while
  the stream route does. The terminal has moved its approvals and its background counts to the tree
  (`watchTreeApprovals`, `watchTree`); what still reads the stream is its transcript, which moves
  once an agent's channel carries the loop's events, and the readers go with the stream route.

## Testing a UI

`fakeServer(handlers)` (`testing/`) is a `fetch` that answers the API's routes as a test says:
each request is matched to its route in `API_ROUTES`, a JSON answer is checked against the route's
schema (so a fake can't answer what the real backend couldn't), and `calls` records what was sent.
A UI tests its own logic on it; the real routes are tested end to end in the backend. A stream
route's handler yields that route's own frames (a conversation stream's entries, a subscribe
stream's frames, sent as the backend sends them, with their event names and no id) or a refusal.
Its streams are taken as they are read, so a handler that throws drops the connection after the
frames before it, as a network does.

## Other languages

A client in another language reads `openapi.json` (`@sheavly/protocol`), written from the same
table. It isn't generated into this package: the generators don't yet read OpenAPI 3.2's `QUERY`
or its stream `itemSchema`, which three of the routes use.

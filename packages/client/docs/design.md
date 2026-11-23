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

## Reconnecting

The backend resumes a stream after the `Last-Event-ID` it is given, so a dropped connection loses
nothing. `reconnectingEntries` (`client/`) does it for a UI: it takes an `open` that opens the
stream after a `lastEventId`, yields each entry once and in order (an entry at or before the last
one seen is skipped), and on a drop waits (250 ms, doubling to 5 s) and opens again. A stream
that ends cleanly ends it (unless it is `endless`, a conversation's whole stream, which only the
client leaves: its end is a cut by the backend, a slow consumer, and so a drop), and so does the
`signal`. After six attempts in a row, with no entry arriving and no connection staying up for 30
s between them, it throws `StreamLostError`, with the `lastEventId` it reached and the `cause`, so
a UI can show that it lost the stream instead of guessing. A refusal (4xx) or an entry off the
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

## Testing a UI

`fakeServer(handlers)` (`testing/`) is a `fetch` that answers the API's routes as a test says:
each request is matched to its route in `API_ROUTES`, a JSON answer is checked against the route's
schema (so a fake can't answer what the real backend couldn't), and `calls` records what was sent.
A UI tests its own logic on it; the real routes are tested end to end in the backend.

## Other languages

A client in another language reads `openapi.json` (`@sheavly/protocol`), written from the same
table. It isn't generated into this package: the generators don't yet read OpenAPI 3.2's `QUERY`
or its stream `itemSchema`, which three of the routes use.

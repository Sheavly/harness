# @sheavly/client

The harness's HTTP client for UIs: every route of the API (`API_ROUTES`, in `@sheavly/protocol`),
its params and body typed and its answer parsed with the contract's schemas, and its server-sent
event streams. A transport (`sheavly.transport`): only apps depend on it, so the library always
runs in-process without it. The routes themselves are the backend's (`apps/backend`).

```ts
import { createClient } from '@sheavly/client/client/client.helper';
import { promptEntries } from '@sheavly/client/prompt/prompt.helper';

const client = createClient({ url, token });
const { id } = await client.call('startConversation', { body: {} });

// The send is answered at once; the run's entries come from the conversation's stream.
for await (const entry of promptEntries({ client, id, prompt: { text: 'hi' } })) render(entry);
```

A conversation's channels are read through subscriptions: the tree kept live, and one node followed,
each resumed after a drop from the cursor of its last entry, with nothing missed and nothing repeated.

```ts
import { watchTree } from '@sheavly/client/tree/watch-tree.helper';
import { followNode } from '@sheavly/client/nodes/follow-node.helper';

const watch = await watchTree({ client, id, onChange: render, signal });
watch.ended.catch(showThatTheTreeIsNoLongerLive); // it rejects when the channel fails or is refused
for await (const entry of await followNode({ client, id, node, signal })) show(entry);

// Commands to a node are typed calls of the contract's routes: no wrapper.
await client.send('cancelNode', { id, node });
```

| Module       | What it holds                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| ------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `approvals/` | `watchApprovals` / `followApprovals`: a conversation's approvals, each with the sub-agent that asked (`HeardApproval`), learned from the stream, so a UI needn't build that itself                                                                                                                                                                                                                                                                                                                                      |
| `client/`    | `createClient`: a client built from `API_ROUTES`, every call typed and parsed; `createPublicClient`: one with no token, for the public routes only; `verifyServer`: proves a server holds the token without ever sending it; `readEntries`: an SSE stream's entries; `reconnectingEntries`: a stream that resumes after a drop; `followConversation`: a conversation's stream, so reconnecting; `subscribeChannels`: the frames of the channels a subscription follows, resumed from each channel's cursor after a drop |
| `nodes/`     | `followNode`: one node's channel as entries, from a position to its `closed` entry, across reconnects                                                                                                                                                                                                                                                                                                                                                                                                                   |
| `tree/`      | `watchTree`: a conversation's tree kept live from its snapshot and the tree channel, across reconnects                                                                                                                                                                                                                                                                                                                                                                                                                  |
| `prompt/`    | `promptEntries`: sends a prompt and yields the entries of the run it starts, whether it started at once or waited in the queue                                                                                                                                                                                                                                                                                                                                                                                          |
| `errors/`    | `RefusedError` (the backend's `code`), `AnswerError` (an answer off the contract), `StreamLostError` (a stream it gave up reconnecting), `PromptRefusedError` (a queued prompt that could not start), `AnswerTooLargeError` and `RedirectedError` (a public route's answer over 4 KB, or a redirect), `VerifyTimeoutError` and `EmptyTokenError` (from `verifyServer`)                                                                                                                                                  |
| `testing`    | `fakeServer`: a `fetch` that answers the routes as a UI's test says, checked against the contract; `setUpTestProfile`: a real backend given a default profile with one fake `openai` model through its own API                                                                                                                                                                                                                                                                                                          |

## Docs

- [Design](docs/design.md): the calls, verifying a server (the token is never sent during it, and
  only a verified server may be sent it), errors, testing a UI on the fake, other languages.

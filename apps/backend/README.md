# @sheavly/backend

The harness backend: it builds each conversation from its settings (provider and model, tools,
hooks, workspace trust) and serves them to every UI over HTTP. This is where a run's choices
live; a UI decides only how to show it, and none is built into the backend. Runs include
`web_search` backed by a fallback chain of free keyless backends (Tavily, TinyFish, Exa, Parallel,
Wikipedia) without signup, ordered by `WEB_SEARCH_BACKENDS`; `WEB_SEARCH=false` disables it.
Embedding apps can inject a different search backend or a keyed one.
Coding runs and their sub-agents share dedicated `glob`/`grep` discovery, the reading/editing/deletion
tools and enabled web tools. Children get their own task tools, including `await_tasks`, even at
the nesting limit. Restart an already running backend after updating its tool composition.

```bash
npm run serve -w @sheavly/backend                  # from source; prints the URL and, to a terminal, a token
```

It calls the real model API, so it costs money. The models and keys it uses are the user's, in
`~/.sheavly` (see [models and keys](docs/harness.md#models-and-keys)), not in the environment or a
`.env`. A UI that starts its own backend (the terminal does) passes its settings in the environment and reads the
`→ listening on <url>` line it prints once ready.
What a conversation has used (reported tokens and recorded cost estimates, per node and in total,
and how full each agent's context is) comes from `GET /conversations/{id}/usage` and the `usage`
channel; the conversation's details carry none. Missing usage leaves the context count unknown. Optional model
`pricing` supplies USD per million token rates for
ordinary input, output, cache reads and cache writes; missing rates remain unknown. Optional model
`contextWindow` is the window the agent is told, any positive size: 300,000 tokens when unset,
and UIs offer "300K" and "1M".

The ordinary SSE stream also carries structured `harness_notice` events before model calls.
Every UI receives the shared protocol payload without a special endpoint or provider imports
and chooses its own presentation. Notices are not assistant messages or model-facing prose.

A prompt ends when the model finishes, even while background commands or sub-agents run; only
`await_tasks` keeps it open. When finite work finishes while the conversation is idle, the
conversation starts a run itself to deliver the notice, and its entries arrive on the
conversation's stream (`QUERY /conversations/{id}/stream`), which a UI follows while idle.
Persistent services (started with `start_service`) never wake it; their notice reaches the next
prompt. Closing the conversation stops its remaining background work.

A finished task or sub-agent is a persistent notice: the same typed payload (the sub-agent's card
data and whole report, or the task's snapshot) is sent as a `harness_notice` event and stored in
the conversation's history as a `notice` entry, so a reopened conversation returns it from
`GET /conversations/:id/messages`. With `await_tasks`, a `tasks-finished` notice retains the
reason and member notices together, delivered only when the entire group finishes. The backend
adds nothing to it; the stores keep it as written.

| Folder        | What it holds                                                                                                                                                               |
| ------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `harness/`    | What a run includes (`createBackendHarness`), each served conversation (`servedConversation`), the settings                                                                 |
| `api/`        | The HTTP API (`createApiApp`): every route of `API_ROUTES` with its handler, the token, SSE, errors                                                                         |
| `discovery/`  | Whether a server takes the one-server lock and writes its discovery file, and what it publishes                                                                             |
| `run-server/` | `runServer`: settings, `Conversations`, the API, the lock, and shutting it all down, as one function; `startServer` is its start, for a caller that ends the process itself |
| `serve.ts`    | The entry point: it only calls `runServer`                                                                                                                                  |

The `sheavly` command (`apps/sheavly`, the launcher) starts the server in its own process, so the
backend exports `@sheavly/backend/run-server/run-server.helper` (`runServer({ env, args, exit })`,
the process's own by default; [serving](docs/serve.md#runserver)),
`@sheavly/backend/run-server/embedded-server.helper` (`startEmbeddedServer`, a loopback server for
a command that goes on living;
[serving](docs/serve.md#a-server-for-a-command-that-goes-on-living)) and, for that command's
tests, from source only, its server-process fake and its types (`testing/serve-process.fake`,
`testing/serve-process.types`) and the fakes the finder's tests meet: a held lock with a
discovery file for any address (`testing/held-server.fake`), listeners that record what they
are sent (`testing/recording-server.fake`, `testing/recording-server.types`), and the check
that one was asked only the handshake and never sent the token
(`testing/handshake-only.fake`). Nothing else is public:
the layout check refuses an export `LAUNCHER_ENTRIES` doesn't list
(`packages/eslint-config/docs/layout.md`).

## Docs

- [Serving conversations](docs/serve.md): its settings, how a UI starts it, an example with `curl`.
- [The API](docs/api.md): the routes, streams, resuming, approvals, errors and security.
- [What a run includes](docs/harness.md): the tools, hooks and settings, and why here.

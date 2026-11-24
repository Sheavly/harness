# @sheavly/providers

Model backends for the harness, written against `@sheavly/core`'s `Provider` and `Adapter`
contracts and nothing else, so they can be used without the harness. A UI builds its provider
here and passes it in; no other package depends on this one at runtime.

```ts
import { createDefaultRegistry } from '@sheavly/providers/registry/default-registry.helper';

const provider = createDefaultRegistry().create('openai', {
  apiKey,
  model: 'gpt-6.1-sol',
  // How a call is sent: required, like the model, since it is the caller's choice.
  request: {
    responseTimeoutMs: 60_000,
    retries: 2,
    retryDelayMs: 1000,
    offlineTimeoutMs: 3_600_000, // wait up to an hour for a lost connection (0: never)
    probeUrls: ['https://www.gstatic.com/generate_204', 'https://1.1.1.1'],
  },
});
```

| Module                | What it holds                                                                                                                                                                                                                                                                 |
| --------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `registry/`           | `AdapterRegistry` (kind + config → `Provider`), `describe`, `validateDefinition`, `check`                                                                                                                                                                                     |
| `switch/`             | `ProviderSwitch`: swap, remove or pin a provider between turns (states tabled in the class)                                                                                                                                                                                   |
| `http/`               | What every protocol shares: `sendRequest`, its retry policy and its wait for a lost connection, `readReply`, replay check, output-token limits, and `createModelFetch`, the `fetch` model calls use ([why](docs/backends.md#the-model-fetch-one-tcp-segment-per-clienthello)) |
| `responses/`          | The OpenAI Responses protocol: `createResponsesProvider`, `defineResponsesAdapter`                                                                                                                                                                                            |
| `chat-completions/`   | Native Chat Completions: `createChatCompletionsProvider`, `defineChatCompletionsAdapter`, `readChatReply`                                                                                                                                                                     |
| `anthropic-messages/` | The Anthropic Messages protocol: `createMessagesProvider`, `defineMessagesAdapter`                                                                                                                                                                                            |
| `openai/`             | Backend: config → Responses endpoint (Bearer key)                                                                                                                                                                                                                             |
| `azure/`              | Azure backends: `openai.adapter` (Responses), `chat.adapter` (Chat Completions), `anthropic.adapter` (Messages)                                                                                                                                                               |
| `bedrock/`            | Amazon Bedrock backends: `anthropic.adapter` (Claude, Messages), `openai.adapter` (GPT, Responses)                                                                                                                                                                            |
| `errors/`             | `AdapterError`, `ModelApiError`, `ProviderSwitchError`                                                                                                                                                                                                                        |
| `testing/`            | Fakes for tests: Responses API items, a model call, a local server that captures a TLS ClientHello (`client-hello.fake`)                                                                                                                                                      |

The caller chooses the backend and the model: adapters validate config but have no default model.
Messages and Responses providers attach reported token usage to the final `done` event. Messages
usage deltas are cumulative; its cache tokens are added to ordinary input. Responses cached input
is already part of its input total, so it is not counted twice. No provider guesses prices.

All three protocols format an ordered array of typed harness notices with the core's shared formatter.
Context telemetry, running-task snapshots and output-continuation notices coexist and are explicitly
labeled harness data rather than user requests, even when an API requires a user role,
and never mutate conversation history or system instructions. See
[harness notices](../core/docs/providers.md#harness-notices).

Chat Completions uses its own nested function tools, streamed deltas and `finish_reason` markers.
It bounds replies with `maxTokens`, reports final token usage, and optionally replays plain
`reasoning_content` under endpoint/model provenance across tool and user turns, including
assistant replies without tool calls. Explicit `effortProfile: 'deepseek'` maps loop efforts to
`low/high/high/max`; the default `'openai'` retains `low/medium/high/xhigh`, without deployment-name
inference. Thinking and replay remain separate options. Automatic cache usage counts reported
hits once and misses as uncached input, never cache writes; missing fields are not proof of
measured caching. See [Chat Completions on Foundry](docs/backends.md#chat-completions-on-foundry).
Truncated replies never release incomplete tool calls. `chat-reply/` is internal and closed in
package exports.

Messages replies preserve their original content-block order and request-prefix provenance.
An explicit `max_tokens` termination with an open block retains streamed text and completed tool
calls, but discards unfinished tools and thinking so the loop can request continuation. Other open
block endings fail with the stop reason and block types, never their content.
Signed thinking is replayed only while that prefix still matches; thinking whose source tag
does not match the current endpoint and model is omitted without losing text or tool calls. A reply keeps the transient notice blocks its request
carried and the next request sends them again in the same place, so a changing notice no longer
costs the thinking; the model therefore reads earlier notices. See
[the replay tradeoff](docs/prompt-caching.md#signed-thinking-replay-and-transient-notices) and
[Model effort](docs/backends.md#model-effort).

Azure Claude supports `thinkingMode: 'adaptive'`, budgeted `'enabled'` thinking, and `'disabled'`.
Adaptive thinking takes no fixed budget; `maxTokens` limits output per reply, not the context
window. The registry's connection check gives fixed, actionable explanations for common thinking,
output-limit and rate-limit failures without returning provider error bodies. See
[Models on Azure](docs/backends.md#models-on-azure) and
[checking a model](docs/backends.md#describing-adapters-and-checking-a-model).

Claude and GPT also run on Amazon Bedrock (`bedrock-anthropic`, `bedrock-openai`), over the
Messages and Responses protocols of its `bedrock-runtime` endpoint, signed in with a Bedrock API key
or an IAM access key pair (each request signed anew with AWS Signature Version 4). The model is an
inference profile ID whose prefix the caller chooses, and Claude's `maxTokens` is required. Its
connection check explains a Bedrock 403, 404 and 400, and a signed request's expired token, clock
and signature, in fixed text. See
[Models on Amazon Bedrock](docs/backends.md#models-on-amazon-bedrock).

## Docs

- [Backends](docs/backends.md): creating and switching providers, describing adapters and checking a
  model, and adding a backend.
- [Prompt caching](docs/prompt-caching.md): how each backend caches a prompt, what a request sends,
  and what it means for the provider contract.

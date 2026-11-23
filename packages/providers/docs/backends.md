# Backends

Creating a provider from the registry, switching between them, and adding a backend.

## Creating and switching providers

Every adapter is created from the registry with a config object that is checked by zod. The
caller picks the model and how each call is sent (`request`); neither has a default:

```ts
import { createDefaultRegistry } from '@sheavly/providers/registry/default-registry.helper';
import { ProviderSwitch } from '@sheavly/providers/switch/switch.service';

const registry = createDefaultRegistry();
const request = { responseTimeoutMs: 60_000, retries: 2, retryDelayMs: 1000 };

// A provider is added under the model's id, never its display name: the id is what is switched by.
const SOL = '4b1f9a52-3c5e-4a77-9d64-0e2b7f1c8a30';
const GPT = '9d2c7e10-6a4b-4f38-b1e5-5c0a8d3f2b71';

const providers = new ProviderSwitch()
  .add(
    SOL,
    registry.create('openai', {
      apiKey: process.env.OPENAI_API_KEY,
      model: 'gpt-6.1-sol',
      request,
    }),
  )
  .add(
    GPT,
    registry.create('azure-openai', {
      apiKey: process.env.AZURE_OPENAI_API_KEY,
      baseUrl: 'https://<resource>.openai.azure.com/openai/v1',
      deployment: '<your-deployment-name>',
      request,
    }),
  );

providers.use(GPT); // swap at runtime; applies from the next model call
```

The switch's `contextWindow` is the active provider's, so it follows a swap; one from `pinned(key)`
keeps the window of the provider it was pinned to. An adapter doesn't know its model's window: the
host wraps the provider it builds with one (the backend app does, from the model's file).

## Models on Azure

Every model deployed on Azure uses the adapter for its endpoint's protocol, all in
`azure/`:

| Model                                                            | Adapter           | `baseUrl`                                            |
| ---------------------------------------------------------------- | ----------------- | ---------------------------------------------------- |
| GPT on Azure OpenAI                                              | `azure-openai`    | `https://<resource>.openai.azure.com/openai/v1`      |
| Foundry models on `/responses`                                   | `azure-openai`    | `https://<resource>.services.ai.azure.com/openai/v1` |
| Foundry models on `/models/chat/completions`, including DeepSeek | `azure-chat`      | `https://<resource>.services.ai.azure.com/models`    |
| Claude                                                           | `azure-anthropic` | `https://<resource>.services.ai.azure.com/anthropic` |

`deployment` is the deployment name in the portal. A model whose `/responses` sends no encrypted
reasoning back takes `reasoning: false`. `explicitCache` (also on `openai`) defaults to `true` and caches history before transient
notices; a model before GPT-5.6 needs `explicitCache: false`. It is never inferred from the
deployment name. See [prompt-caching.md](prompt-caching.md). Claude needs `maxTokens`: the maximum output tokens per
reply including thinking, not the context window. An explicit limit must fit the deployment's
output limit; omit it to use the model-aware default described below.
`thinkingMode: 'adaptive'` lets supported models choose their own thinking budget, with no
`thinkingBudget`. Models such as Sonnet 5.5 require adaptive rather than enabled thinking.
`thinkingMode: 'enabled'` requires `thinkingBudget` (at least 1024, under `maxTokens`);
`'disabled'` turns thinking off. For existing configurations without a mode, a budget enables
thinking and no budget leaves thinking unspecified:

```ts
registry.create('azure-anthropic', {
  apiKey: process.env.AZURE_CLAUDE_KEY,
  baseUrl: 'https://<resource>.services.ai.azure.com/anthropic',
  deployment: 'claude-sonnet',
  maxTokens: 16_000,
  thinkingMode: 'adaptive',
  request,
});
```

Pass `providers` as the `provider` option of `runAgent`.

### Chat Completions on Foundry

`azure-chat` accepts the portal's full `/models/chat/completions?api-version=...` URL or its
base `/models` URL. It preserves the embedded API version unless explicitly overridden, and
never appends `/responses` to a Chat endpoint. The Responses adapter rejects Chat endpoint URLs
before sending a request, with a message naming the appropriate protocol.

Chat requests use native `messages`, nested function tools and streamed deltas. `maxTokens`
bounds total reply output. Left empty it defaults to the documented 384000 for the recognized
DeepSeek names (`deepseek-flash`, `deepseek-v4-flash`, `deepseek-v4.1-flash-1017`,
`deepseek-v4-pro`, matched case-insensitively; [pricing page](https://api-docs.deepseek.com/quick_start/pricing)),
and for any other deployment the request sends no `max_tokens`, so the server's own limit applies. `replayReasoning: true` retains plain
`reasoning_content` from every assistant reply, including replies without tool calls, across
parallel tools, further tool calls and subsequent user turns. Replay uses full operation URL
(including API version) and model provenance: other endpoints, models, encrypted Responses
reasoning and Claude signatures are never forwarded. With replay disabled, reasoning is neither
emitted as retained state nor serialized; ordinary text and tool calls remain unchanged.

`effortProfile` explicitly selects native effort mapping and defaults to `'openai'` in both
`azure-chat` and `createChatCompletionsProvider`. It is never inferred from a deployment name:

| Loop effort | `effortProfile: 'openai'` (default) | `effortProfile: 'deepseek'` |
| ----------- | ----------------------------------- | --------------------------- |
| low         | low                                 | low                         |
| medium      | medium                              | high                        |
| high        | high                                | high                        |
| extreme     | xhigh                               | max                         |

Optional `thinkingMode` sends `thinking: {type: 'enabled' | 'disabled'}` through the existing
Foundry extra-parameter pass-through. Leave it unspecified for the deployment default. Disabled
thinking omits a conflicting `reasoning_effort`; a call without a loop effort sends no effort.
The profile changes effort mapping only, not thinking or replay defaults. For a DeepSeek
snapshot that supports these upstream settings, configure all three explicitly:

```ts
registry.create('azure-chat', {
  apiKey,
  baseUrl:
    'https://<resource>.services.ai.azure.com/models/chat/completions?api-version=2024-05-01-preview',
  deployment: '<your-deployment-name>',
  effortProfile: 'deepseek',
  thinkingMode: 'enabled',
  replayReasoning: true,
  request,
});
```

[DeepSeek's thinking guide](https://api-docs.deepseek.com/guides/thinking_mode/) documents
`low/high/max` and maps `medium` and `xhigh` aliases to `high`; using `max` is therefore necessary
for extreme effort. When requests carry tools, the guide requires all prior `reasoning_content`,
even from assistant replies without a tool call and earlier user turns. Without tools, upstream
ignores prior reasoning. The serializer preserves opted-in own-provenance reasoning in either
case. [Azure's inference client reference](https://learn.microsoft.com/en-us/python/api/azure-ai-inference/azure.ai.inference.chatcompletionsclient?view=azure-python-preview)
describes model-specific root body fields and the `extra-parameters` header, not a guarantee
that any particular Foundry deployment supports these thinking, effort, replay or cache semantics.
Check the deployment's documentation; these changes were verified with injected fake transport,
not live calls against a V4.1 snapshot.

The reader accepts Azure's nullable optional tool/usage fields. A finish reason is required;
truncated replies never release partial tool arguments. Complete tool calls are assembled by
index, with valid IDs, and final usage includes reported cache reads without counting them twice.
No reply-state service is shared between calls. See [Chat cache accounting](prompt-caching.md#chat-completions-backends-deepseek-azure-chat).

## Models on Amazon Bedrock

Two adapters in `bedrock/` call the regional `bedrock-runtime` endpoint, signed in with an Amazon
Bedrock API key or an IAM access key pair, over the two protocols it serves natively. Neither needs
a new protocol or the AWS SDK:

| Model  | Adapter             | Protocol           | Endpoint                                                      |
| ------ | ------------------- | ------------------ | ------------------------------------------------------------- |
| Claude | `bedrock-anthropic` | Anthropic Messages | `https://bedrock-runtime.<region>.amazonaws.com/anthropic/v1` |
| GPT    | `bedrock-openai`    | OpenAI Responses   | `https://bedrock-runtime.<region>.amazonaws.com/openai/v1`    |

Both take `auth` (`api-key` or `access-key`, a choice a model's file records), the secrets of that
way (below), `region` (a Region code such as `us-east-1`, checked so the host cannot be steered
elsewhere) and `model`,
an **inference profile ID**: a prefix, the provider, then the model, such as
`us.anthropic.claude-sonnet-5-5` or `global.openai.gpt-6-astra`. A bare model ID is refused, since
most Bedrock models cannot be called in-Region, and the prefix is never filled in for you: it decides
where a request may run. A geography (`us`, `eu`, `ca`, `au`, `jp`) keeps requests there; `global`
lets them run in any commercial Region. Which prefixes a model has differs per model (its card in the
[Bedrock model list](https://docs.aws.amazon.com/bedrock/latest/userguide/model-cards.html) names them),
and a prefix is no proof of residency: check the profile with `GetInferenceProfile` from each source
Region. The adapters accept `us`, `us-gov`, `ca`, `eu`, `au`, `jp`, `apac` and `global`; another
prefix is refused before a request is sent (add it to `bedrock.constants.ts` when AWS adds one), and
Bedrock answers for a known prefix the model lacks. The ID may hold only letters, digits and
`. _ : -`.

```ts
registry.create('bedrock-anthropic', {
  auth: 'api-key',
  apiKey: process.env.BEDROCK_API_KEY,
  region: 'us-east-1',
  model: 'us.anthropic.claude-sonnet-5-5',
  maxTokens: 16_000,
  thinkingMode: 'adaptive',
  request,
});

registry.create('bedrock-openai', {
  auth: 'access-key',
  accessKeyId: process.env.AWS_ACCESS_KEY_ID, // the secrets of this way only
  secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
  sessionToken: process.env.AWS_SESSION_TOKEN, // only for temporary credentials
  region: 'us-east-1',
  model: 'us.openai.gpt-6-astra',
  request,
});
```

- **`maxTokens` is required for Claude, and the adapter has no default.** Bedrock holds back the
  input plus `max_tokens` from the model's token quota when a call starts, and output tokens burn the
  quota faster on the newest Claude models, so the 128000 default of Azure would starve the quota.
  Set what the replies need. Setup suggests 32000 for a model from its catalogue, as the answer to
  the question, which a person accepts or changes. The thinking fields are Azure Claude's (see
  [above](#models-on-azure)).
- **Credentials.** Every credential is a secret: it goes to the credential store, never into the
  model's file, and is never read from `~/.aws` or `AWS_*` variables (the example above reads them
  for illustration only). A model signs in one way, `auth`, and a secret of the other way is refused:
  - `api-key`: `apiKey`, a Bedrock API key sent as `x-api-key` (Claude) or a Bearer token (GPT). A
    short-term key lasts up to 12 hours and works only in the Region it was made in, so it must be
    replaced when it expires; a long-term key creates an IAM user, and AWS recommends it for
    exploration, not production.
  - `access-key`: `accessKeyId` and `secretAccessKey`, and a `sessionToken` for temporary
    credentials. Nothing but a signature is sent: every request, each retry included, is signed with
    AWS Signature Version 4 for the `bedrock` service in the model's Region, at the time it is sent
    (`bedrock/sigv4.utils.ts`, a signer tested against AWS's published examples). The signature is
    good for about five minutes, so a clock that is off is refused. Temporary credentials expire:
    replace them in `--setup`.

  Either needs permission to call `bedrock:InvokeModel`, and for GPT also on the account's default
  project. Shared profiles, SSO and role chains are not supported.

- **GPT runs stateless.** The Responses protocol sends `store: false`, so nothing is kept on Bedrock
  between turns (its default is to keep a response for 30 days). Responses on `bedrock-runtime` are
  synchronous, and have no server-side tools or application inference profiles; the harness uses
  client-side tools only.
- **Model access** is per account and may take up to 15 minutes after subscribing; until then a call
  answers 403. Claude models before Opus 4.7 also need the Anthropic use case form.
- **Signed thinking** is bound to the model and the prefix that produced it, and on some Claude models
  to the AWS account, so replaying it under another account is a 400. A model's `replaySource` covers
  its endpoint (and so its Region) and profile, not the account.
- **Caching:** see [prompt caching on Bedrock](prompt-caching.md#amazon-bedrock).
- **The connection check** explains a Bedrock 403 (a refused key, or model access, the Region or
  permissions), a 404 (an unknown profile or Region) and a 400 in fixed text, never Bedrock's own
  message. For a signed request it also tells an expired session token, a clock that is off, a
  signature that did not match and an access key ID AWS does not know apart. Its 429 is a quota, and 503 or 529 mean Bedrock is short of capacity: the retry policy
  below already retries 429 and 5xx.

What is not covered: Converse and InvokeModel (the models that speak neither protocol, such as Nova,
Llama or Mistral), shared profiles, SSO and role chains, Agents, Knowledge Bases, Guardrails, batch inference, provisioned
throughput and application inference profiles. Pricing is not guessed: enter it per model. The
adapters were written from AWS's public documentation and tested against fake HTTP. What a real
Bedrock account has confirmed, by the author with a signed access key pair: a SigV4 request for
the `bedrock` service is accepted on both the `/anthropic/v1/messages` and the
`/openai/v1/responses` route and streams as server-sent events, and a model set up through
`--setup` with `access-key` credentials answers. Not confirmed: sending a Bedrock API key (the
`x-api-key` and Bearer headers are from AWS's documentation), and Bedrock's own error and throttle
behaviour.

## Sending a call: timeouts and retries

For Messages replies, `message_stop` with open content blocks is accepted only when the server
explicitly reported `max_tokens`. Already streamed text and completed tool calls are retained;
unfinished tools are never executed and unfinished thinking is never replayed. The final usage and
output-limit reason reach the loop's bounded continuation. A missing terminal event or any other
stop reason with open blocks remains a failure. Diagnostics name the stop reason and block indexes
and types without including text, arguments or signatures.

`request` decides how each call is sent, in every protocol (`http/request.helper.ts`):

- `responseTimeoutMs`: how long to wait for the response to start (its headers). Without it a
  backend that accepts a call and never answers holds the run for Node's five minutes. It covers
  the start only: a long reply streams for as long as it takes.
- `retries` and `retryDelayMs`: a call that fails before anything streamed is sent again, up to
  `retries` more times, waiting `retryDelayMs`, doubled each time and cut by jitter to between
  half and all of it (or the server's `retry-after`, in seconds or as an HTTP date, if longer).
  The policy is `http/retry-policy.helper.ts`. It retries a request that never reached the server, one that timed out, HTTP 429
  and 5xx; any other HTTP error fails at once. Once an event has streamed it never retries, since
  the turn may have started tools: a stream cut off mid-reply fails the run.
- An interrupt (the run's `signal`) stops the wait and every attempt, and is never retried.

A call that still fails throws a `ModelApiError` (its message names the API) whose `reason` says why (`network`,
`timeout`, `http` with its `status`), with the original error as `cause` and Node's own reason
in the message (`UND_ERR_SOCKET: other side closed`), so a saved run says what happened.

### The model fetch: one TCP segment per ClientHello

Calls go through the `fetch` in the registry's `AdapterDeps`. By default, and in the backend app,
that is `createModelFetch()` (`http/model-fetch.helper.ts`), not Node's global `fetch`. Hand an
`AdapterRegistry` another `fetch` only in tests.

- **Why:** Node 22.20+, 24.5+ and 26 bundle OpenSSL 3.5. By default it sends a 1,216-byte ML-KEM
  key share, which makes the TLS ClientHello about 1,600 bytes and splits it across two TCP
  segments. Gateways that read only the first segment reset the connection: Azure AI Foundry
  does, and every call failed with `ECONNRESET … before secure TLS connection was established`
  ([#458](https://github.com/Sheavly/harness/issues/458), [tldr.fail](https://tldr.fail)).
- **What it does:** it offers `MODEL_TLS_GROUPS` (`http/http.constants.ts`). X25519 comes first,
  so only its 32-byte key share is sent and the ClientHello stays under one segment.
  `X25519MLKEM768` is still listed, so a server that prefers post-quantum key exchange
  (Anthropic, OpenAI, Cloudflare) asks for it with a HelloRetryRequest and gets it, at the cost
  of one round trip per new connection.
- **On an older OpenSSL:** OpenSSL before 3.5 (Node 24.0 to 24.4, or a system OpenSSL 3.0) has no
  ML-KEM and refuses a list that names it. `offeredTlsGroups` tries the list once, and on that
  refusal leaves OpenSSL's default in place. That default sends no ML-KEM share, so its
  ClientHello already fits in one segment.
- **HTTP/1.1 only:** the pool sets `allowH2: false`, as Node 24's own `fetch` sends. undici 8
  would otherwise also offer HTTP/2, which changes how a stream, an abort and a timeout behave.
- **No proxy:** the model fetch's own pool bypasses the global dispatcher. Model calls go
  straight to the endpoint even when `NODE_USE_ENV_PROXY` and `HTTPS_PROXY` are set, or when the
  process set its own `setGlobalDispatcher`. Proxy support is
  [#463](https://github.com/Sheavly/harness/issues/463).
- **Certificates:** they are checked as they are for Node's own `fetch`. A test pins that a
  server with a certificate the client can't verify is refused.
- **What it takes:** a URL or string, with a string or byte body, as `sendRequest` sends. A
  global `Request` or a `FormData` body rejects with a `ModelFetchError`, because undici's own
  `fetch` can't read them. `sendRequest` passes that error through and never retries it.
- **What not to do:**
  - Don't reorder the list. In a plain list only the first group gets a key share.
  - Don't replace it with a "retry with classical groups after a reset" fallback, which an
    attacker could force with a reset.
  - Don't call Node's global `fetch`, or open a connection another way, in this package's
    source: send through the injected `deps.fetch`. `modelFetchConfinement`
    (`packages/eslint-config/src/model-fetch-confinement.js`, spread into this package's
    `eslint.config.js`) fails these in source files, tests and fakes aside:
    - `fetch(…)` and `globalThis.fetch(…)`;
    - an import of `undici` or of a Node network module.

    Only `http/model-fetch.helper.ts` imports them.
- **Why undici's own `fetch`:** it pairs undici's own `fetch` with its `Agent`. Node's global
  `fetch` rejects an `Agent` from the npm package (`UND_ERR_INVALID_ARG`) whenever the bundled
  undici's version differs.

## Describing adapters, and checking a model

A UI that sets a model up never imports this package. The backend reads the registry for it:

- `registry.describe()` lists every adapter for a form: its config as JSON Schema, without what the
  backend supplies (the request policy), with the secret fields marked (`secret: true`), the names
  of the secrets, and `remoteField`, the field that holds what the provider calls the model
  (`model`, `deployment`). Fields carry a `title` and `description` for labels and help.
- `registry.validateDefinition({ kind, definition, host })` says what is wrong with a model's
  fields before any key exists: the secret is stood in for, `host` supplies the request policy, and
  the adapter's own schema judges the rest. A key inside a definition is itself a problem, since a
  model's file holds none. `registry.secretFields(kind)` says which fields are secrets.
- `registry.check({ kind, config })` asks the model one tiny question through the adapter's own
  provider and stops at the first thing it says, so the key, the endpoint and the deployment are
  all tried at once. It never retries, gives up after `responseTimeoutMs`, and ends as `valid`,
  `invalid` (401/403), `not_found` (404), `rejected` (any other refusal) or `unreachable` (a server
  failure, the network, a timeout). HTTP 400/422 messages explain known adaptive-thinking and
  output-limit failures, or point to the settings to check; HTTP 429 says to retry or check quota.
  These are fixed explanations, never the provider's error text, which can echo what was sent.
  Aborting `signal` rejects instead; that is not an answer. The tiny question is authored in
  internal `registry/registry.prompt.ts`; request policy and fixed failure messages stay in
  `registry.constants.ts`.

What marks a field is in its schema, so an adapter that reuses `apiKeySchema` and
`requestPolicySchema` is described correctly with nothing more. A field named like a secret that is
not marked one fails a test for every registered adapter.

`providers.pinned(key)` hands out the provider added under `key` and keeps it there whatever the
switch is set to, for a run pinned to one model (a sub-agent) while the main session switches. A
host adds each provider under a model's id; a display name is never a key.

### Model effort

The backend selects low, medium, high or extreme independently for each model and conversation.
`ProviderSwitch.setEffort` changes future calls, with the effort captured in `ProviderRequest.effort`
when the stream begins. `pinned` captures that effort as well as the provider, so a sub-agent is
not moved by a later switch.

Responses APIs receive `reasoning.effort` (low, medium, high, or xhigh for extreme). The
Anthropic Messages API receives adaptive thinking and `output_config.effort` (low, medium, high,
or max for extreme), with no fixed thinking budget. Completed Messages replies are kept as opaque
replay state, with their original text, thinking and tool-block order and a hash of the request
prefix. Signed thinking is replayed only when system instructions, tools and preceding messages
still match. Thinking whose source tag does not match the current endpoint and model, or thinking
after an edited prefix, is left out (and reported) while text and tool calls remain, so invalid
signatures are never replayed. The AGENTS.md and skills hooks append updates to history
rather than rewriting the system prompt. See
[preserved thinking](https://platform.claude.com/docs/en/build-with-claude/preserved-thinking).
This requires a deployment supporting those native effort levels; an unsupported
setting is reported by the provider, never silently relabelled as another effort. Calls without
an effort retain their configured thinking behavior. See
[Anthropic's effort reference](https://platform.claude.com/docs/en/build-with-claude/effort).

### Temperature hint

`ProviderRequest.temperature` is a hint for work that should be repeatable, such as a summary. An
adapter sends it only where its API accepts it beside the call's other settings, and otherwise
leaves it out, so a caller cannot rely on it being applied. Chat Completions sends it unless a
reasoning effort is sent. Anthropic Messages sends it only with thinking off (no effort, no
thinking budget or adaptive mode), since thinking requires the default temperature. Responses
sends it only when the model's `reasoning` is off and no effort is set, since reasoning models
reject it. Nothing retries after a rejection: the fallback is to omit the field.

Azure Claude's `maxTokens` defaults to 128000 for the recognized Foundry IDs `claude-sonnet-5-5`,
`claude-opus-5-5`, `claude-haiku-5-5` and `claude-fable-5-1`, whose documented output limit is 128K
([model specifications](https://platform.claude.com/docs/en/models/overview)). The value is a
ceiling, not a target: only generated tokens are billed. Unknown or custom
deployment names keep a conservative 8192 default, because the Messages API requires
`max_tokens` and the adapter does not guess their capabilities.
Explicit limits, including those already saved in model files, remain unchanged. To use an
automatic default for an existing model, remove its explicit `maxTokens` in advanced setup.
Effort levels do not alter the resolved output limit. The Messages API's `max_tokens` and
`model_context_window_exceeded` stop reasons are distinct in the harness, so the loop only
attempts output continuation for the former.

## Adding a backend

- **It speaks the Responses API** (OpenAI-compatible gateways, local servers that support it): a
  folder `src/<name>/` with `<name>.adapter.ts` calling `defineResponsesAdapter({ kind,
description, configSchema, toEndpoint })`. `toEndpoint` is a pure map from validated config to
  base URL, model, headers and query; streaming, tool calls and reasoning are shared. Test the
  mapping in `src/<name>/__tests__/` with `requestSentBy` from `@sheavly/testing/fetch/fake-fetch.fake`.
- **It speaks the Anthropic Messages API** (Claude on Azure AI Foundry, or elsewhere): the same,
  with `defineMessagesAdapter` from `anthropic-messages/messages.helper.ts`; its config also has
  `maxTokens` (the API requires it) and an optional `thinkingBudget` (extended thinking, whose
  signed blocks are resent like Responses reasoning). Test it with `requestSentBy(..., reply:
[{ type: 'message_stop' }])`, so the fake ends the stream the Messages way.
- **It speaks another protocol** (Google Gemini, Chat Completions): a protocol folder next to
  `responses/` and `anthropic-messages/` with its own `create<Name>Provider` that turns a
  `ProviderRequest` into that API's request and its stream into `StreamEvent`s, and backends built
  on it. What every protocol shares is in `http/` (`sendRequest` and its retry policy, `readReply`,
  the output-token limits, the replay check, the config schemas, `parseToolArguments`); nothing in
  one protocol's folder is reused by another.
  - **Read the reply with `readReply`** (`http/reply-reader.helper.ts`), never your own loop over
    the SSE reader (`harness/no-handrolled-reply-reader` fails the import). Give it `parse` (the
    typed event, or undefined for one you don't use), `step` (events to yield, and `ended` on the
    event that finishes the reply; throw a `ModelApiError` for an error event) and `finish` (replay
    state, then `done` with the stop reason and usage). It decides, once: unknown events are
    skipped, a stream that ends early is `cut_off` unless the caller aborted, and `done` follows a
    complete reply only. `http/__tests__/reply-reader.conformance.test.ts` runs the same
    scenarios through every protocol: add yours to it.
  - **Reasoning replay:** build the `source` with `replaySource` and filter stored items with
    `ownReplay`, which reports each item left out to `onReplayDropped` with a reason
    (`ReplayDropReason`); report your own reasons through the same handler.
  - **Output tokens:** put a model's limit table in `http/output-tokens.constants.ts`.
  - **Failures:** a failure after the reply started streaming is never retried by the provider.
- Register it in `createDefaultRegistry` if it is built in, or `registry.register(adapter)` from
  the caller.

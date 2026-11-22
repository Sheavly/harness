# What a run includes

The system prompt is the generic base, the sections the run's extensions contribute (the `coding`
extension its guidance) in activation order, then the app's own `instructions`. An app passes only
its own `instructions` and, if it wants to replace the generic base, `baseInstructions`; the
backend gives the host's `harness.systemPrompt` what the activated extensions contributed, once,
after all have activated (the returned harness's `instructions` is a getter on that live text). An
extension with the `system-prompt:replace` grant may replace the generic base when the app passes
no `baseInstructions`; next to an app `baseInstructions` it is refused and the run fails, naming
the extension, unless the app lists the reserved name `baseInstructions`
(`BASE_INSTRUCTIONS_SECTION`) in `omitInstructionSections`. That app option leaves out the named
sections extensions contribute (`coding` for the coding guidance, or a third party's declared
section name) while keeping the extension; the app always wins, an unknown name fails the run
(`UnknownInstructionSectionError`, the extensions closed first, like the conflict error), and
sub-agents get the same composed text. A name the run did not contribute includes one from an
extension that was skipped as untrusted or for a missing service, so omit only what the run's
extensions contribute. The error goes to the caller; the extensions, whose `signal.reason` is
set when the run is stopped, are told only that composing the prompt failed, never the names.
Backend conversations use that composed text by default; sub-agents receive it before
their narrower child role. The terminal and workbook use this same backend path, not separate
prompt copies. See [instruction composition](../../../packages/host/docs/harness.md#instruction-composition).

The packages provide pieces and the services a run shares; the backend decides what its runs
include, in one place, `createBackendHarness` (`src/harness/harness.helper.ts`). Every
conversation it serves, for whichever UI, is built on it, by `servedConversation`
(`src/harness/served.helper.ts`), so they all run the same agent.

## The run

`createBackendHarness` builds the host's services (`createHarness`, with the app's own
instructions), keeps the file locks (the `fileLocks` it is given, shared by every run of an app, or
its own) and gives them to the `coding` extension, which opens the workspace and its process
runner itself. It then composes:

| What                                                  | From              | Why                                                                                                                                                                   |
| ----------------------------------------------------- | ----------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `read_file`, `write_file`, `edit_file`, `delete_file` | `@sheavly/coding` | A coding agent works on files; all four share the run's `KeyedLocks` and `FileReads` (an edit needs a read first)                                                     |
| `glob`, `grep`                                        | `@sheavly/coding` | Discover workspace files and search their contents with dedicated, confined tools rather than shell discovery                                                         |
| `read_skill`                                          | `@sheavly/coding` | Reads a listed skill, from the project's or the user's skill folders                                                                                                  |
| `web_fetch`                                           | `@sheavly/tools`  | Public HTTP(S) pages as readable text, with bounded downloads and no credentials; omitted with `WEB_FETCH=false`                                                      |
| `web_search`                                          | `@sheavly/tools`  | Bounded titles, URLs and snippets, with UI artifacts; a fallback chain of keyless backends (Tavily first) unless another is injected, omitted with `WEB_SEARCH=false` |
| `run_command`                                         | `@sheavly/coding` | Commands, piped and chained without a shell; the user is asked before any they have not allowed                                                                       |
| `task_status`, `cancel_task`, `await_tasks`           | `@sheavly/tools`  | Inspect or cancel background work, or group its completions with a reason                                                                                             |
| `start_agent`, `message_agent`                        | `@sheavly/tools`  | Sub-agents get file tools, `read_skill`, the run's task registry (scoped to their session) and `run_command`, plus the shared hooks                                   |
| The AGENTS.md hook                                    | `@sheavly/coding` | First, so the project's rules apply from the first call                                                                                                               |
| The skills hook                                       | `@sheavly/coding` | Lists the [skills](../../../extensions/coding/docs/skills.md), the user's too (`~`)                                                                                   |
| The `.sheavly/` hooks                                 | `@sheavly/coding` | Only in a trusted workspace (`--trust`); `projectTrust` says why not                                                                                                  |

Sub-agents receive the same file tools, including `glob`, `grep` and `delete_file`, and enabled web
tools as the main agent. Their `task_status`, `cancel_task` and `await_tasks` operate on their own
task registry, including at the nesting limit; only further delegation is disabled there.
Sub-agents run commands on their own task registries with the same workspace permissions and
approvals as the parent. They receive the same hooks, including `.sheavly/` hooks only when the
workspace is trusted. A child's finite work keeps that child active before it reports to its parent.
The backend explicitly passes `web_fetch` to sub-agents when enabled. The same tool instance
shares the host's limits and domain policy, but each call has its own request and cancellation.
See [web fetch](../../../packages/tools/docs/web-fetch.md) for address rules and defaults.

The backend also explicitly selects keyless search for `web_search`, with no signup or credential
setup. A served conversation searches through a fallback chain (`SearchChains`, ordered by
`WEB_SEARCH_BACKENDS`, default `tavily,tinyfish,exa,parallel,wikipedia`): keyless Tavily answers
first, and the next backend is tried only when it is rate limited, slow (8 seconds) or failing.
Queries go only to the backends the chain reaches, and only when the tool is called; results are
untrusted external data. When every backend fails the error names them, not the reasons.
`createBackendHarness` itself defaults to keyless Tavily alone. `WEB_SEARCH=false` omits search
from both main and sub-agent runs.
An embedding app can instead pass `webSearch: { backend }` to `createBackendHarness`, using its
own search backend or a Tavily backend constructed with an injected API key. Credentials are
not model input, and packages never discover them from the environment. See
[web search](../../../packages/tools/docs/web-search.md) for the contract, bounds and artifacts.

**Extensions.** The run is built by an `ExtensionHost` from three built-in extensions (`web`,
`agents`, `coding`, in that order) and the ones an embedding app passes as `extensions`, after
them. A third-party extension needs no edit of our source: it ships a `sheavly.json` manifest
(`readManifest`, `@sheavly/extension/manifest/manifest.helper`) naming it, its dependencies, the
services it reads and provides and the tools, hooks and work kinds it contributes, and passes it
to `defineExtension({ manifest, activate })`. It can depend on a built-in by name, and its tools,
hooks and work kinds join the run (a name that collides fails it). The host holds it to the
manifest: a service read, or a tool, hook or work kind contributed, that the manifest does not
declare fails that extension like any activation failure (the run stops with an
`ExtensionUndeclaredError`, and the extensions that had activated are deactivated), and one whose `services.requires` the run cannot offer is
left out and listed in `skippedExtensions` with `reason: 'service'` and the `missing` names (an
untrusted or dependent one has `untrusted` or `dependency`). A name ending in `*` in the manifest
declares names only known at run time, as `coding` does for the `.sheavly/` hooks of a workspace.
The app supplies the
host with run services (`runServices`), which every extension reads without a `dependsOn`. Their
keys are exported by `@sheavly/extension/run-services/run-services.utils`:

| Key                                              | What it is                                                                                   |
| ------------------------------------------------ | -------------------------------------------------------------------------------------------- |
| `INSTRUCTIONS`, `MAIN_SESSION`                   | The system prompt (a live read-only view) and the run's main session                         |
| `SESSION_INFO`, `CHILD_SESSIONS`                 | Read-only session metadata; the sub-agents the extension started                             |
| `BACKGROUND_TASKS`, `TASK_CONTROL`               | The tasks the extension started; any task of the calling session                             |
| `MODEL`                                          | The run's provider, for model calls                                                          |
| `APPROVALS`                                      | Where a tool asks the user for approval (`request` and `listening` only)                     |
| `OUTPUT_READER`, `OUTPUT_CAPTURE` (with a store) | Reading EVERY command's complete output (may hold secrets); creating a capture (`find` them) |

Each is built per extension and checks the `grants` its `sheavly.json` declares; none is a
registry. `MAIN_SESSION` is a frozen copy, and what a scope returns or shares is frozen copies.
`APPROVALS` builds the request itself: attributed to the extension, no `keeps`, no `always_allow`,
so an answer never becomes an allow rule, unless the manifest declares `approval:as-tool` (the
request may name a tool the extension contributes) or `approval:keep` (it may offer to
keep an answer, shown to the user). `TASK_CONTROL` trusts the `sessionId` it is given, so
`task:*-any` lets an extension name any session of the run. The `sub-agents` service `agents`
provides is write-only (`share`). This is least privilege, not a sandbox (see
[scoped run services](../../../packages/host/docs/run-services.md)); an extension gets its
configuration from its settings (see "Layered extension settings" below), not from the
environment. An extension can place a hook
before or after another by name (`placeHook`), for example before the built-in `agents-md` hook.
`src/harness/__tests__/third-party-capabilities.test.ts` shows each of these from an extension that
uses only public exports. The built-ins read the same services under the same grants, with no
exception: `coding` opens its own workspace and process runner, and reads the sessions, tasks,
approvals and main session through the run services.

**What an extension emits.** An extension tells a UI or the model something through
`context.emit` (`@sheavly/extension`), never by importing the runtime: it declares `emits` in its
manifest (event kinds, and `modelFacingNotices` for notices) and returns the kinds and topics with
the schema of their `data` from `activate`. The backend gives the `ExtensionHost` the sink that
carries what the host already checked (`harness/extension-emit.helper.ts`): an event is published
on the target session's stream as an `extension_event` with `seq: 0` (like `storage_failed`), a
notice is queued in the session's outbox and published by the loop at its next turn as a
`harness_notice` and a history entry. The target is the session the extension names (a tool passes
`context.session`), by default the main session, and it can be any session of the run, sub-agents
included: one registry serves one conversation (`createBackendHarness` makes a registry per
conversation), so it cannot reach another conversation. The host parses the finished envelope with
the protocol's own schemas before the sink sees it, and disarms an extension's `emit` wherever it
stops, drops or fails the extension (it throws `deactivated` afterwards). The sink is a host
option, not a run service, so an extension that only holds the emit capability cannot emit under
another's name. That is as far as it goes: no scoped service hands out `publish`, `queueNotice`
or `publishTask` (`send` and `report` do produce session updates), but extension code is Node and could import the runtime to reach a registry by another route (lint
rejects the import in an extension's source, review covers the rest), so it could impersonate
another extension to the model. A session's outbox holds at most 100
notices; past that, and for a notice for an ended session, `emit.notice` throws to the extension.
A reopened conversation replays the stored events and keeps the notices in history.
`src/harness/__tests__/third-party-emit.test.ts` shows it from an extension that uses only public
exports.

**Layered extension settings.** The values of the settings extensions declare in their
`sheavly.json` come from three files and then the manifest's default. Strongest first:

| Layer     | File                                     | Read by                                                        |
| --------- | ---------------------------------------- | -------------------------------------------------------------- |
| global    | `~/.sheavly/settings.json`               | `servedConversation`, at each start (`readUserSettingLayers`)  |
| profile   | `~/.sheavly/profiles/<id>/settings.json` | the same: the file of the profile the conversation is bound to |
| workspace | `<project>/.sheavly/settings.json`       | `createBackendHarness` itself (`resolveSettings`)              |

`~/.sheavly` is `SHEAVLY_HOME`. A file is `{ "settings": { "<extension>.<setting>": value } }`
with string, number or boolean values and nothing else at the top level. A value the user's own
global or profile file sets wins over the workspace's, so a repository can never override the
user. `createBackendHarness` takes the two already-read user layers as `settingLayers`,
layers them with the workspace file before it builds the
`ExtensionHost`, and gives the host the final values (`settings`) and where each came from
(`settingSources`). `settings` on the returned run lists every declared setting with its `value`
and its `source`: `global`, `profile`, `workspace` or `default`.

**Scope and restricted.** A workspace file is repository content. A setting's `scope` is `user`
unless its manifest says `scope: "project"`: a `user` setting (the default) can be set only from
the user's own files, a `project` setting may also be set from a workspace file, and one that is
also `restricted` only while the workspace is trusted. A non-restricted `project` setting applies
from an untrusted repository too, so an extension author declares one only when any repository may
set it.

**What is fatal and what is only reported.** A global or profile file is the user's own: one that
is not valid JSON, has the wrong shape, is too large or unreadable, or sets a name no extension
declares or a value of another type, fails the conversation's start with an error that names the
file and the reason, never what it contains: a `SetupError` (`invalid`), which the API answers as
422 with that message, and which `servedConversation` throws before the conversation exists. A
workspace file is shared by a team and can be hostile, so no refused or unusable file and no
trust-store failure (a `TrustStoreError` or a system error with an errno code such as `EACCES`) is
fatal: an unusable file counts as an empty layer, a name that does not apply is left out, and a
trust step that fails (see Trust) counts the workspace as untrusted. What is still fatal is the
user's own global and profile files, and a program error (anything else, such as Node's
`ERR_INVALID_ARG_TYPE`), which is rethrown loudly. Not covered: a FIFO inside a trusted
`.sheavly/` makes the trust check hang, because the fingerprint opens every entry (tracked as
issue #385, which makes the fingerprint skip special files); and a very large file under
`.sheavly/` is read in memory by the trust check. Each problem is
reported in `ignoredSettings` on the returned run and, when non-empty, in the conversation details
(`GET /conversations/:id`, the optional `ignoredSettings` field), and as one log line,
`settings: ignored <name> from <file>: <reason>`. An entry has a `reason` of `not-declared`,
`wrong-type`, `scope` or `restricted`; a whole file, or its trust, has no name and one fixed cause:
`too-large`, `not-a-file`, `link` (a link out of `.sheavly/`, or a `.env` file), `not-utf8`,
`unreadable` (anything else, such as permissions), `not-json`, `bad-shape` (JSON, but not a
settings file) or `trust-unavailable`. A report never carries a value, any of the file's text or a
system error's message. At most 20 entries are listed; `ignoredSettingsMore` in the details, and
one line `settings: ignored <n> more entries from <file>` in the log, count the rest, so a hostile
file cannot make the report long. A `file` has its control characters and escape sequences removed
and is cut to the wire's 8192 characters, so a folder's name cannot reach a terminal or break the
details.

When the workspace's `.sheavly/` is the user's own folder (its real path is the user's
`SHEAVLY_HOME` or holds it: the workspace is the user's home, or a folder whose `.sheavly` is the
user's folder), there is no workspace layer, no trust call and no report: the global and profile
files are its files already, and the trust store would sit inside the workspace. The match is by
real path and path segments, not a string prefix, so a link to the folder counts and
`.sheavlyfoo` does not. A workspace that is only a parent of the home (`/home` for
`~/.sheavly`) is not caught: its `/home/.sheavly/settings.json` is a project file, the trust store
refuses to sit inside the workspace with a `TrustStoreError`, and the start reports
`trust-unavailable`, which is safe and not fatal.

**Trust.** Only when `.sheavly/settings.json` exists does the backend consult the trust store:
it checks trust (`--trust` grants it first), reads the file, and checks again. The workspace
counts as trusted only if both checks said `trusted`, so a file that changed between the check
and the read is not trusted. A trust store that cannot answer (a corrupt trust file, a store inside
the repository, a file under `.sheavly/` that cannot be read: a `TrustStoreError` or an errno) is
not fatal either, while a program error is rethrown: the workspace
counts as untrusted, its file is still read, and `trust-unavailable` is reported; the coding
extension's own handling of hooks trust is separate and unchanged. A race stays: a writer that
changes the file and restores it between the two trust checks is not detected; the text read is the
text used, and the trust it was read under says only that the folder matched before and after.
Without the file the trust store is not touched. Trust covers the
whole `.sheavly/` folder, so editing `settings.json` after trusting makes the workspace `changed`
and its restricted values are ignored again. `--trust` therefore also records trust for a
repository that has only a `settings.json` and no hooks (it did not before). The coding
extension later grants the same trust again for `.sheavly/hooks.json`; granting twice in one start
is harmless, because each grant records the folder as it is then.

The backend's environment settings (`MAX_TURNS`, `SUMMARY`, `WEB_*`, `MODEL_*`...) are a separate
mechanism and are not read from these files. Files are read once when a conversation starts; a
change applies to the next one.

**Summaries.** Unless `SUMMARY=false`, the main run and every sub-agent summarize their history
when the context nears the window (`backendSummary`, `harness/summary.helper.ts`). The model the
conversation is on writes the sections it is asked for (`modelSummarizer`, `@sheavly/summary`),
and rules keep the user's own words and a trail of the files and commands the work touched
(`fileTrail`, `@sheavly/coding`). The main run's summarizer uses the model switch, so a switch
changes who writes the next summary; a sub-agent's uses its pinned model. A sub-agent's first
message is the task its parent agent wrote, so its checkpoint lists it under "Task from the parent
agent", never "What the user asked for" (`subAgentSummary`). A trail line is left out when its
call's result was an error. The parent-task heading is authored in the internal
`harness/summary.prompt.ts`; provider selection, redaction and section wiring stay in
`summary.helper.ts`.

Summaries are on by default, so a long history, tool inputs and results included, is sent to the
model that writes the summary: the same provider the conversation already uses, in an extra call.
Credential forms are redacted first, and again in what the model writes (`redactDiagnosticText`,
a pattern match that misses unfamiliar forms). `SUMMARY=false` sends nothing extra. Thresholds are
the loop's defaults; the
[loop doc](../../../packages/loop/docs/run.md#summaries) says how a checkpoint is made and
rejected.

AGENTS.md and skill-list updates are appended as instruction context, not substituted into the
system prompt. Earlier messages remain unchanged, keeping Claude's signed reasoning valid.

`servedConversation` wraps it as a conversation (`harnessConversation`: the workspace's skills,
`MAX_TURNS`) and reports its run for `GET /conversations/:id`: the workspace,
the model in use and the ones it can switch to, workspace trust and the permission mode (read when
asked, since the user can change it while the conversation runs). A run's `run_command` reads its
folder's permissions from the user's folder (`workspacePermissions`), so a mode or an allowed
command applies to every conversation in that folder from its next command.

Finite background commands and sub-agent replies keep the prompt alive by default and resume
the parent automatically when they finish. Persistent services (started with `start_service`)
are exempt: they may outlive a prompt without keeping it active. Interrupting a prompt cancels
its background work, including sub-agent descendants, and does not restart it automatically.

`workspacePermissions` creates one `ConversationPermissions` per live conversation. Permanent
entries still come from the workspace store; temporary `allow_session` entries live only in that
object and are not restored on reopen. Main and sub-agent command tools sharing it reuse the
grants; sub-agent commands do not bypass permission checks.

## Models and keys

The models a conversation runs on are the user's, kept in their folder (`~/.sheavly`, or
`SHEAVLY_HOME`), never in the environment and never in a `.env`:

- **A profile** is a bundle of models, keys and conversations (work, personal). A workspace runs
  on the profile it is bound to, else the default one (`ProfileRegistry.profileFor`). Nothing
  is named by what a person typed: a profile and a model are their ids (lowercase UUIDs); the
  name is a label.
- **`Profiles`** (`src/profiles/profiles.service.ts`) is the one place in the backend that holds a
  key. `modelsFor` combines each of the profile's models with its key, builds a provider for it
  through the adapter registry (`@sheavly/providers`), and puts them behind one `ProviderSwitch`
  keyed by model id. Each conversation gets its own switch, so changing one conversation's model
  leaves the others alone; `PUT /conversations/:id/model` (the chat's `/model`) switches it.
  Its registry sends every model call, and every key check, through `createModelFetch()`, never
  Node's global `fetch`. Its TLS ClientHello fits in one TCP segment, which Azure AI Foundry
  needs on Node 22.20+, 24.5+ and 26. See
  [the model fetch](../../../packages/providers/docs/backends.md#the-model-fetch-one-tcp-segment-per-clienthello).
- **Where it starts.** A new conversation starts on the profile's last model (the one chosen last
  in any of its conversations), else its first. A switch is remembered for the next conversation
  without touching the ones running. Profiles keep `lastModelSelection` (the model/effort pair)
  and `modelEfforts` (each model's last-used effort). Low, medium, high and extreme are reasoning
  efforts; a model with no remembered effort starts on medium. Switching back to a model restores
  its latest effort in the profile, even if another conversation changed that preference. A
  resumed conversation instead restores its own saved pair. An effort-only switch is persisted
  through the same API, without changing the model.
- **DeepSeek snapshot setup.** The app catalogue offers **DeepSeek V4.1 Flash (1017)** with
  identity `DeepSeek-V4.1-Flash-1017`, family `deepseek`, and only the `azure-chat` hosting route.
  Its suggested deployment is that exact snapshot string; a differently named Azure deployment
  can retain the same model identity. The preset sets `replayReasoning: true`,
  `thinkingMode: enabled` and `effortProfile: deepseek`. The existing **DeepSeek V4 Flash** entry
  still suggests `deepseek-v4-flash` with only `replayReasoning: true`; neither catalogue listing
  nor provider construction rewrites saved definitions or silently switches their effort profile.
  The explicit DeepSeek profile maps medium to `high` and extreme to `max`; low and high retain
  their names. Omitting the profile keeps the adapter's OpenAI mapping (extreme to `xhigh`).
  Use the Azure Foundry Chat Completions endpoint, for example
  `https://resource.test/models/chat/completions?api-version=2024-05-01-preview`, not Responses.
  The user confirmed that endpoint shape and API version for the requested deployment. Offline
  fake-transport tests verify setup persistence, provider construction, request fields and
  same-endpoint/model plain-reasoning replay. They do **not** verify live Azure acceptance,
  reasoning behavior, cached-token reporting, cache billing or model quality; no live call was
  made to establish those properties. Resource hostnames and private connection settings are
  not catalogue defaults.
- **Responses caching.** `openai` and `azure-openai` models use explicit caching unless their
  definition sets `explicitCache: false`; the backend stores, shows and checks the definition as
  given and never guesses from a model or deployment name. A deployment before GPT-5.6 rejects the
  fields with a 400, so it must set `explicitCache: false`. See
  [prompt caching](../../../packages/providers/docs/prompt-caching.md).
- **A model that can't be used** (no key, a definition its adapter refuses) is left out with a
  note on the log, and never costs the user the others. A note says which model and why, never the
  key and never what a provider answered.
- **Not set up.** With no profile for the workspace, or none with a usable model, a conversation is
  refused with `not_set_up` (HTTP 409) and a message that says what to do, and a UI onboards the
  user. The backend starts all the same: it has to be running for a UI to set it up.
- **Trust** is `trusted-workspaces.json` in the same folder (`trustStoreFor`), shared by every
  profile, and outside every repo so a repo can't trust itself.
- **Permissions** are `permissions/<workspace-key>.json` in the same folder (`permissionStoreFor`),
  shared by every profile for the same reason: what `run_command` may run is about a folder, and
  must be somewhere the agent can't edit. `PermissionSetup` is what the permission routes call;
  `workspacePermissions` is what a run's `run_command` reads.

## Settings

What stays in the environment is how this process runs, not who the user is. `serve.ts` passes
`process.env` in:

- `SHEAVLY_HOME`: the user's folder (default `.sheavly` in their home).
- `parseRequestEnv`: how each model call is sent, `MODEL_RESPONSE_TIMEOUT_MS`, `MODEL_RETRIES` and
  `MODEL_RETRY_DELAY_MS`, defaulting to `REQUEST` (60s, 2 retries, 1s). See
  [sending a call](../../../packages/providers/docs/backends.md#sending-a-call-timeouts-and-retries).
- `parseServerEnv` and `parseRunEnv`: where it listens, and how each conversation runs
  ([serve.md](serve.md#settings)).
- `harness.constants.ts`: the request policy. A run has no turn limit unless `MAX_TURNS` sets one.

No package has any of these: another backend reads its own settings and composes its own run.

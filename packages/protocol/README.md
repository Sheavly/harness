# @sheavly/protocol

The wire contract: everything the harness sends a UI or accepts from one (`AgentEvent`,
`SessionUpdate`, `StreamEntry`, `ApprovalUpdate`, `ApprovalResponse` and the types inside them), as zod schemas.
Every type is `z.infer` of its schema, so the types and what goes over the wire can't drift. It
depends on zod only.

```ts
import type { AgentEvent } from '@sheavly/protocol/event/event.types';
import { agentEventSchema } from '@sheavly/protocol/event/event.validator';
```

A client in another language reads `contract.schema.json`, the whole contract as one JSON Schema,
or `openapi.json`, the HTTP API as an OpenAPI 3.2 document. After changing a schema or a route,
run `npm run schema -w @sheavly/protocol`; a test fails while either file is out of date.

Model-first setup uses `GET /setup/models` to return `ModelOffering` choices and supported hosting
routes. Optional `ModelIdentity` metadata keeps the chosen model separate from its profile UUID,
display name and adapter definition; a model need not have one. Catalogue values
belong to the backend app; this package defines and validates only their wire shapes.

| Module               | What it holds                                                                                 |
| -------------------- | --------------------------------------------------------------------------------------------- |
| `event/`             | The loop's `AgentEvent`s and the `ToolArtifact` they carry                                    |
| `session/`           | `SessionRef`, `SessionInfo`, the `SessionUpdate` stream                                       |
| `stream/`            | `StreamEntry`: every session's events and updates, in one order                               |
| `approval/`          | `ApprovalRequest`, `ApprovalUpdate`, `ApprovalResponse`                                       |
| `queue/`             | `QueueUpdate`: a conversation's queued lines joining, starting or refused, on the stream      |
| `node/`              | `NodeInfo`: one unit of work of any kind (agent, command, service, extension kind), its state |
| `channel/`           | A node's channel: cursors, its `opened`, `updated`, `event`, `closed` entries, a log's shape  |
| `tree/`              | The tree channel: its entries, its snapshot, and the fold from entries to a tree              |
| `subscription/`      | The subscribe request, its limits, and its stream's frames (entry, head, end, snapshot)       |
| `node-command/`      | Commands addressed by node: a message to an agent, and the ids a prompt send returns          |
| `task/`              | Background task states                                                                        |
| `status/`            | The one status table (session, run, task, node, turn stop) and `runEnd`: how a run ended      |
| `message/`           | What a model is sent, and the `PromptPart`s a user typed                                      |
| `history/`           | `HistoryMessage`: the stored conversation, above message, session and task                    |
| `skill/`             | `SkillInfo`: a skill as a UI lists it                                                         |
| `server/`            | The server's requests, responses and `ServerError` codes                                      |
| `output/`            | `OutputRef`, `OutputLog`: the reference to a command's complete output, and its completeness  |
| `store/`             | `StoredConversation`: a past conversation as the store lists it                               |
| `model/`             | A model's id, name and file, `AdapterDescription`, and the `KeyCheck` result                  |
| `setup/`             | `GET /setup` and the profile, model and credential requests of a setup UI                     |
| `id/`                | `lowercaseUuidSchema`: the shape of every id a file or folder is named by                     |
| `profile/`           | A profile's identity and model preferences                                                    |
| `terminal-settings/` | Global terminal preferences, shared by every profile                                          |
| `usage/`             | Reported per-call token usage, recorded cost estimates and cumulative totals                  |
| `notice/`            | `HarnessNotice`: model and UI data carried by `harness_notice` events                         |
| `connection/`        | `ModelConnection`: a model call waiting for the network, or retrying an unreachable provider  |
| `extension/`         | The envelope fields, name patterns and size caps of an extension's events and notices         |
| `permission/`        | A folder's command permissions: its mode and the commands the user allowed                    |
| `time/`              | `timestampSchema`: when something happened, in milliseconds since the epoch                   |
| `api/`               | `API_ROUTES`: every HTTP route's method, path, schemas and `public` flag; `openApiDocument`   |
| `contract/`          | `contract.schema.json`, generated from the schemas                                            |
| `version/`           | `PROTOCOL_VERSION`, the semver functions and `checkProtocolVersion`: which side is older      |
| `handshake/`         | The nonce, instance id and proof schemas, `handshakeProof` and `verifyHandshakeProof`         |
| `discovery/`         | `DiscoveryFile`: what a running server writes for local clients, and `peekFormatVersion`      |

Conversation details keep `contextUsage` separate from cumulative `usage`: the latest main-session
measurement (`used`), active window (`window`) and snapshot position (`throughSeq`). Unknown
measurements are omitted so clients cannot confuse missing counts with an empty context.

Conversation details may carry `ignoredSettings`: what a workspace's `.sheavly/settings.json` asked
for that did not apply. Each entry is `{ layer: 'workspace', name?, file?, reason }` (type
`IgnoredSettingReport`): with a `name`, that entry was left out (`not-declared`, `wrong-type`,
`scope`, `restricted`); without one, the whole file at `file` was left out, or its trust could not
be decided, for a fixed cause (`too-large`, `not-a-file`, `link`, `not-utf8`, `unreadable`,
`not-json`, `bad-shape`, `trust-unavailable`). The object is strict and never carries a value, any
of the file's text or a system message. The list holds at most 20 entries (`MAX_IGNORED_SETTINGS`)
and `ignoredSettingsMore` counts the entries left out of it (absent when none were). Both fields
are absent when nothing was ignored, never an empty list or a zero, so an older client is unaffected.

Before each model call with known context data, a `harness_notice` event carries the same typed
notice the model receives. UIs can display or ignore it through the ordinary stream; the payload
contains no model instructions or UI presentation. Completion notices share `TaskCompletionContext`
(`reason`, `startedAt`, `durationMs`, `userMessagesSinceStart`, optional `callId`). Their `context`
field is required. `TaskInfo.reason` is the explicit `await_tasks` reason retained per grouped
task, absent on ungrouped tasks.
`running-tasks` is a transient, nonempty snapshot with at most 10 entries: task ID, title (max 200
characters), agent-authored reason (max 1000 characters), epoch `startedAt`, and optional scalar
`group` (the first requested member ID). `total` equals shown entries plus `omitted`; commands and
output are forbidden. Limits are published in `notice/notice.constants.ts`; inferred types are
`RunningTask` and `RunningTasksNotice`. Persistent history rejects this kind.
See [harness notices](docs/contract.md#harness-notices).

## Docs

A prompt a person typed carries a stable `id`; stream entries carry the originating `messageId`.
Both are optional because other user messages (a hook's context) have none. The contract is
versioned by this package's own version (`PROTOCOL_VERSION`, also `contractVersion` in
`contract.schema.json` and `info.version` in `openapi.json`): two versions are compatible on the
same major from 1.0.0, or the same major and minor while the major is 0, with any patch; a
wire-breaking change is a major bump (a minor below 1.0.0) written in its changeset. The constant
is generated by `npm run schema -w @sheavly/protocol`, and `handshakeProof` is the one definition
of the handshake HMAC, served by `QUERY /handshake` beside `GET /health`: the two routes marked
`public`, which answer without the bearer token (every other route is private unless it says
`public: true`). The harness reads only data written under the
contract: see [Version](docs/contract.md#version). A `run_failed` event reports selected error details,
including a bounded stack and cause chain, before the failed session update. These diagnostics
never enter model history.

- [The wire contract](docs/contract.md): what is in it, what stays out, and how it is checked.
- [The wire model](docs/wire-model.md): the decided, not yet built, replacement for the single
  combined stream: nodes, channels and subscriptions.
- [Where each current entry goes](docs/wire-model-mapping.md): every entry of today's stream and
  the channel and entry type it becomes.
- [Who changes with the wire model](docs/wire-model-consumers.md): every workspace that reads or
  writes today's stream, and what changes in each.

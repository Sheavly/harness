# Debugging a run

Start from what the run stored. Everything a conversation did is on disk, so read it before guessing.

## Where the data lives

`~/.sheavly`, or `$SHEAVLY_HOME` when set:

```
~/.sheavly/
  config.json                    the default profile and which profile a workspace uses
  trusted-workspaces.json        workspaces whose `.sheavly/` code may run (fingerprints)
  logs/backend.jsonl             the server's log: failures with no conversation (startup, scratch)
  permissions/<workspace-key>.json   SENSITIVE: command approvals, shared across a repo's worktrees
  recovery/                      by-hand repair material, not written by the harness
  profiles/<profile-id>/
    models/<model-id>.json       a model's non-secret settings
    credentials.json             SECRET: never read, print or paste it
    workspaces/<workspace-key>/conversations/<conversation-id>/
      index.json                 id, title, modelId, mode, workspace, profile, status, startedAt, updatedAt
      stream.jsonl               every entry of the combined stream, in order
      history.jsonl              the model's history, per session
      log.jsonl                  the conversation's log: failed runs, hooks and tool calls (from the stream) and what the backend logged (a failed request or background run)
      queue.json                 { queued: [...] } lines typed while a prompt ran
      shell.json                 the conversation's working root
      agents/                    sub-agent histories
      outputs/                   captured command output
```

The workspace key is a hash of the workspace path, so find a conversation by searching `index.json` for the title or the workspace instead of computing it.

Elsewhere: `workbook/runs/<id>/` (a workbook run: its prompt, events, `transcript.txt`, `result.json`; a run without `result.json` did not finish), `MODEL_CALLS_FILE` (opt-in log of model requests: SENSITIVE, it holds prompts and may hold more; read it by field, never print it whole), and `~/.cache/sheavly-harness/chats/<chat-id>.json` (the dev hooks' per-chat state: files edited, hints shown).

## Reading a conversation

Each line of `stream.jsonl` is `{ seq, sessionId, kind, at }` plus `event` (for `kind: 'event'`, an `AgentEvent` with a `type`) or `update` (a session, task or approval update). `seq` is contiguous; a gap or a missing `done` is the first thing to look for. `history.jsonl` lines are `{ seq, entry }`. `log.jsonl` lines are log entries (`@sheavly/logger`): `level`, `event`, `time` (epoch milliseconds), `service` and the fields of that event. The stream's failures are `run.failed`, `hook.failed` and `tool.failed` with their `seq`, `toolName` and `toolCallId`; the backend's are `api.request_failed`, `prompt.failed`, `conversation.wake_run_failed`, `extension.problem` and the like (each module's `LOG_EVENT` is the catalogue, with a `LOG_EVENT_MEANING` each; [logging.md](logging.md) says how entries are made). An `error` is `{ name, message, stack, code?, causes: [...] }`: read `.error.causes` before the top message. Nothing rotates or trims a log: delete it by hand if it grows.

`npm run replay` reads the stream and nothing else: no backend, no model, no network, never `credentials.json`. It takes a conversation folder (the one holding `stream.jsonl`) or a workbook run (its id, its number, `last`, or its folder holding `sessions.sse`):

```bash
C=~/.sheavly/profiles/<profile>/workspaces/<key>/conversations/<id>
npm run replay -- $C --summary             # counts per kind, sessions and their end states, tasks, and what is wrong
npm run replay -- $C                       # the stream through the same Renderer the demo prints with
npm run replay -- $C --from 40             # from that seq on
npm run replay -- $C --session <id>        # one session's entries, that session as the main one
npm run replay -- last --json              # one entry per line, to pipe into jq
```

`--summary` is where to start: it flags a missing `done` of the main session, a `seq` gap, a cut-off last line and lines that are not entries, which replaces looking for them by hand. A replay of a run without `done` ends by saying how many tool calls were still running, so the state the live renderer was left in is visible. The recipes below cover what replay does not, the other files:

```bash
jq -c '{event, level, time, error: .error.message}' $C/log.jsonl                # every logged failure, one line each
jq -c 'select(.event == "api.request_failed") | {route, status, name: .error.name, causes: [.error.causes[].message]}' $C/log.jsonl
jq -r 'select(.event == "prompt.failed") | .error.stack' $C/log.jsonl           # the stack of a failed prompt
jq -c 'select(.level == "error")' ~/.sheavly/logs/backend.jsonl                 # failures with no conversation
jq -c '.queued' $C/queue.json
```

Stored streams, histories and `outputs/` hold whatever the model and the tools saw, which can include secrets, and `replay` prints them as the live run did. Read what you need (`--summary`, a `--from` range, or `jq` projections of `--json`), and never paste whole entries into a chat or issue.

The field names under `.event` and `.update` are those of the protocol schemas (`packages/protocol/src/event/event.validator.ts`, `packages/protocol/src/session/`, `packages/protocol/src/task/`); read the schema before relying on a field. These recipes use only the keys listed above.

## What to look for

| Symptom                            | Look at                                                                                                             |
| ---------------------------------- | ------------------------------------------------------------------------------------------------------------------- |
| the run "hangs"                    | the last `run_state` and `task_*` entries: a finite task still running holds a run open                             |
| a sub-agent never reported         | its session updates in `stream.jsonl` and its history under `agents/`                                               |
| no `done` at the end               | `run_failed` and the final session update: a failed run may end without a `done`                                    |
| a tool failed                      | `tool.failed` in `log.jsonl`, then the `tool_result` with the same `toolCallId` in `stream.jsonl`                   |
| the client got a bare `internal`   | `api.request_failed` in the conversation's `log.jsonl` (or `logs/backend.jsonl` with no id): its stack and `causes` |
| a background prompt or wake failed | `prompt.failed` or `conversation.wake_run_failed` in `log.jsonl`; clients only saw the session go idle `failed`     |
| the model forgot something         | `history.jsonl`: was it summarised? A checkpoint is a `summary` entry                                               |
| a hook or AGENTS.md did not apply  | `context_added` events and `hook_failed` entries; the working root in `shell.json`                                  |
| a queued line did not run          | `queue.json`: reopening a conversation shows queued lines and runs none of them                                     |
| approvals                          | `approval` entries in the stream and `permissions/<key>.json`                                                       |

## Running and observing the backend

- `npm run serve -w @sheavly/backend` starts the backend. It prints the token if `SERVER_TOKEN` is unset (a secret: never paste it into a chat or issue; set `SERVER_TOKEN` yourself to avoid printing one) and `→ listening on <url>` last. Its settings are env vars: `SERVER_HOST`, `SERVER_PORT`, `SERVER_TOKEN`, `SERVER_DISCOVERY`, `WORKSPACE_ROOT`, `MAX_TURNS`, `SUMMARY`, `CONTEXT_WINDOW`, `MODEL_CALLS_FILE`, `SHOW_MODEL_CALLS` (prints prompts to the terminal), `MODEL_RESPONSE_TIMEOUT_MS`, `MODEL_RETRIES`, `MODEL_RETRY_DELAY_MS`, `SHEAVLY_HOME`, `SHEAVLY_TRUST_FILE`.
- Is a server discoverable? An always-on `npm run serve` (not `SERVER_EXIT_WITH_PARENT=true`, not `SERVER_DISCOVERY=false`) holds its home's one-server lock and writes its discovery file (named server.json) once it listens, in `$XDG_RUNTIME_DIR/sheavly/<12 hex of the home's hash>/` (the home itself when that is unusable), mode 0600, with the token in it: look at it, never paste it. A second server on the same home prints `Another Sheavly server is already running (pid, version, origin)` to stderr and exits 1 (when two start at the same moment the loser can see the lock before the file exists and prints `A Sheavly server holds the lock at <path>; its discovery file could not be read (it has not written one yet)` instead: still exit 1, nothing on stdout); a lock or folder problem is a `Warning:` on stderr and the server runs without a file. A dev terminal's backend takes no lock and writes no file. The default port 4310 moves to a free one when taken (a `→ port 4310 is taken` line, the `→ listening on` line and the file say which); an explicit `SERVER_PORT` that is taken fails. A wrong setting exits 1 before the lock is taken. SIGINT, SIGTERM or SIGHUP, even while starting, removes the file and the lock; a second signal or a kill leaves a file and a `.sock`, and the next start replaces them. Two servers for one home with a different `XDG_RUNTIME_DIR` (set and unset, or two values) do not see each other's lock: if two run, compare the variable in each.
- The API is documented in `apps/backend/docs/api.md` and its schema in `packages/protocol/openapi.json`; call it with the bearer token. Where an error ends the backend logs it once through `@sheavly/logger`: to the conversation's `log.jsonl` (or `~/.sheavly/logs/backend.jsonl` when there is no conversation) and, as a JSON line, to stderr, which a UI that started the backend may lose; the files are what lasts.
- The terminal app connects with `BACKEND_URL` and `BACKEND_TOKEN`, or starts its own backend. `SESSIONS_SSE_LOG` writes the raw stream it received.
- `npm run workbook -- list|show|step|diff` reads stored workbook runs without a model call, and `npm run replay` renders or summarizes a run's (or a conversation's) stored stream, as above. `npm run demo` and `npm run workbook -- check` call a paid model: run them only on purpose.

## Debugging the dev tooling

- A hook message that names a skill or guide is routed by `.agents/skills/*/harness.json`; if a guide is missing, `npm run layout` says which.
- A stop-gate failure is recomputed from disk each round; the rounds are Cursor's `loop_limit` in `.cursor/hooks.json`.
- Per-chat hook state is `~/.cache/sheavly-harness/chats/<chat-id>.json`; deleting a corrupt one resets that chat's hints and recorded edits.

## Rules

- Never open or print `credentials.json` or `.env*` files, and never put the server token, anything under `permissions/` or a whole `MODEL_CALLS_FILE` into a chat or issue. Read stored conversations by field with `jq`, as above, not whole. Lint (`harness/no-credentials-file`, `harness/guard-env-read`) stops code and the file tools from reading them; nothing stops a shell `cat`, so this is a rule you follow, not one that is checked.
- Read stored data; don't edit it to "fix" a conversation. The `recovery/` material was made by hand.
- If you need a field this guide doesn't list, read the schema, then add it here.

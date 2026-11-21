# Serving conversations

`npm run serve -w @sheavly/backend` serves conversations over HTTP to any UI in another process:
the terminal, an editor, a web page, a script. Each conversation runs on its workspace's profile,
with its own switch between that profile's models (so changing its model leaves the others alone),
and the run [harness.md](harness.md) describes. The
routes, streams and errors are in [the API](api.md).

## `runServer`

The whole start is one function, `runServer({ env, args, exit })` in
`src/run-server/run-server.helper.ts`; `src/serve.ts` only calls it, so `npm run serve` is that
call. `env` and `args` default to the process's own (`process.env`, the arguments after the
script) and `exit` to `process.exit`; a command in the same process passes its own. The steps and
their order are the contract: the startup-signal guard is installed before anything is taken, the
backend is built (every setting error comes here) before the lock is claimed, the lock before
anything listens or prints, the stop handlers before the guard comes off, and the `listening`
line last. A refused start (another server holds the lock) calls `exit(1)`, a failing setting or
listen throws. It resolves once the server listens and keeps the process alive.

## Settings

| Setting                     | Default                                  | What it does                                                                                                                                                                                                                               |
| --------------------------- | ---------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `SERVER_HOST`               | `127.0.0.1`                              | Where it listens. It runs commands for whoever reaches it                                                                                                                                                                                  |
| `SERVER_PORT`               | `4310`                                   | The port. Unset, `4310` moves to a free port when taken; `0` picks a free one; both fall back to 20000-32000 when the OS has none. An explicit port that is taken fails, never moves. The printed `→ listening on` address is the one used |
| `SERVER_TOKEN`              | made per run                             | The bearer token every request carries; at least 32 characters                                                                                                                                                                             |
| `SERVER_EXIT_WITH_PARENT`   | off                                      | `true`: stop when stdin closes (the UI that started it is gone). Such a server takes no lock and writes no file, even while another server runs                                                                                            |
| `SERVER_DISCOVERY`          | `true`                                   | `false`: take no one-server lock and write no discovery file. Only `true` and `false` are accepted. See "One server per home" below                                                                                                        |
| `SERVER_ALLOW_REMOTE_SETUP` | off                                      | `true`: take model keys and grant trust even when listening beyond this machine (`SERVER_HOST` not loopback); only behind TLS                                                                                                              |
| `WORKSPACE_ROOT`            | the folder                               | The folder a conversation works in when its start names none: file tools, AGENTS.md, skills and `.sheavly/` hooks                                                                                                                          |
| `MAX_TURNS`                 | no limit                                 | Model calls a prompt may make, per session                                                                                                                                                                                                 |
| `WEB_FETCH`                 | `true`                                   | `false`: omit public web reading from main and sub-agents; only `true` and `false` are accepted                                                                                                                                            |
| `WEB_SEARCH`                | `true`                                   | `false`: omit web search from main and sub-agents; otherwise uses free keyless search with no signup or API key, trying several backends in turn                                                                                           |
| `WEB_SEARCH_BACKENDS`       | `tavily,tinyfish,exa,parallel,wikipedia` | Comma-separated order the keyless search backends are tried in (`firecrawl` is also available)                                                                                                                                             |
| `SUMMARY`                   | `true`                                   | `false`: never summarize a long history, in the main run or a sub-agent; only `true` and `false` are accepted                                                                                                                              |
| `CONTEXT_WINDOW`            | each model's                             | A whole number of tokens: the window every model is told it has, instead of its file's. For a check that must reach the summary trigger without a long run                                                                                 |
| `MODEL_CALLS_FILE`          | none                                     | Appends each model call's full request there, one JSON line each                                                                                                                                                                           |
| `SHOW_MODEL_CALLS`          | off                                      | `true`: prints each model call (task, tools, system prompt) as sent                                                                                                                                                                        |
| `SHEAVLY_HOME`              | `~/.sheavly`                             | The user's folder: profiles, models, keys, conversations and trusted workspaces                                                                                                                                                            |
| `SHEAVLY_TRUST_FILE`        | in the folder                            | Where trusted workspaces are remembered, if not `trusted-workspaces.json` in `SHEAVLY_HOME` (the workbook's checks use a throwaway one)                                                                                                    |

The models and keys are in the user's profile, not here, and not in a `.env`: see
[models and keys](harness.md#models-and-keys). How a model call is sent (`MODEL_RESPONSE_TIMEOUT_MS`,
`MODEL_RETRIES`, `MODEL_RETRY_DELAY_MS`) is in [harness.md](harness.md#settings). `--trust` trusts
the workspace's `.sheavly/` folder: its hooks, and a `.sheavly/settings.json` even when there are no
hooks (see "Layered extension settings" in [harness.md](harness.md#the-run)):
`npm run serve -w @sheavly/backend -- --trust`. The `settings.json` files of the user's folder
(`SHEAVLY_HOME`) are read at each conversation's start.

Without `SERVER_TOKEN` it makes one and prints it once, at start. Once it listens it prints
`→ listening on <url>`, last. Ctrl+C, SIGTERM, closing the terminal or (with
`SERVER_EXIT_WITH_PARENT`) its stdin closing stops it, and with it every conversation's prompts,
background tasks and processes. Skills that didn't load, and each model call with
`SHOW_MODEL_CALLS`, go to stderr.

## One server per home

A server that is not `SERVER_EXIT_WITH_PARENT=true` and has not `SERVER_DISCOVERY=false` takes its
home's one-server lock once its settings are checked, before it listens, prints or writes anything. When another
server holds it, it prints that server's pid, version and address to stderr (never its token) and
exits with 1, having listened for no requests, written no file and changed nothing but its own
lock probe (a socket made briefly in the runtime folder). It prints that only once the first server
has published its file: when two servers start at the same moment the loser can see the lock held
before the file exists, and prints `A Sheavly server holds the lock at <path>; its discovery file
could not be read (it has not written one yet)` instead, still with exit 1 and nothing on stdout.
A setting that is wrong exits 1 before the lock is taken, so it leaves nothing behind.
Once it listens it writes `server.json` (its URL, token, instance id, pid and versions) in a
private folder: under `$XDG_RUNTIME_DIR/sheavly/<hash>` when that is usable, otherwise in the
home. A wildcard `SERVER_HOST` (`0.0.0.0`, `0`, `::`, `::0` and the other spellings of it) is
published as `127.0.0.1`. A `SERVER_HOST` that the URL parser rejects or the file's schema refuses
(a zone id such as `fe80::1%eth0`, a host with non-ASCII letters) is published as given and the
file is then refused: the server runs with a warning and is not discoverable. On a normal stop it
removes the file and then lets go of the lock; so does SIGINT, SIGTERM or SIGHUP while it is still
starting, after which it listens, writes and prints nothing more and exits with the usual code. A second signal while it stops exits at
once and leaves them; a killed server leaves them too, and the next one replaces them. When the
lock or its folder cannot be used, it warns on stderr and serves without them.

The default port moves silently when `4310` is taken, so a UI reads the URL from `server.json` (or
the `listening` line) and does not hard-code `4310`; the server prints one line before `listening`,
`→ port 4310 is taken, so this server listens on <port> instead`, when that happens.

One server per home holds for processes that see the same runtime directory: the lock and the file
are under `$XDG_RUNTIME_DIR` when that is usable and in the home otherwise, so two servers for one
home with a different `XDG_RUNTIME_DIR` (one set and one unset, or two values) do not see each
other's lock. A systemd service and an SSH shell can differ: set the same variable in the service.

## A UI that starts its own

The terminal starts a backend for itself: `npm run serve` of this workspace, by package name, on
`127.0.0.1` with `SERVER_PORT=0`, a token it made, and `SERVER_EXIT_WITH_PARENT=true`, so the
backend stops when the terminal does, even killed. It reads the URL from the `listening` line. Any
UI can do the same, or connect to one already running.

## An example session

```bash
T=<the token>
U=http://127.0.0.1:4310  # only if 4310 was free: otherwise the `listening` line or server.json has the port

# Start a conversation, or find the ones running (another UI may have started one).
curl -s -H "authorization: Bearer $T" $U/conversations
ID=$(curl -s -X POST -H "authorization: Bearer $T" -H 'content-type: application/json' \
  -d '{}' $U/conversations | jq -r .id)

# What the run is: workspace, models, trust.
curl -s -H "authorization: Bearer $T" $U/conversations/$ID

# Send a prompt; its entries stream back as server-sent events until its `done`.
curl -N -X POST -H "authorization: Bearer $T" -H 'content-type: application/json' \
  -d '{"text":"What is in this folder?"}' $U/conversations/$ID/prompts

# Follow the whole conversation from another terminal (QUERY, with a filter body), answering
# approvals: without a client that says `approvals: true`, an approval is refused at once.
curl -N -X QUERY -H "authorization: Bearer $T" -H 'content-type: application/json' \
  -d '{"replay":true,"approvals":true}' $U/conversations/$ID/stream

# The history, and the skills a prompt can run (all, or those a search matches).
curl -s -H "authorization: Bearer $T" $U/conversations/$ID/messages
curl -s -X QUERY -H "authorization: Bearer $T" -H 'content-type: application/json' \
  -d '{"search":"review"}' $U/conversations/$ID/skills

# Stop the running prompt, then close the conversation.
curl -X POST -H "authorization: Bearer $T" $U/conversations/$ID/stop
curl -X DELETE -H "authorization: Bearer $T" $U/conversations/$ID
```

A TypeScript UI uses the typed client instead: `createClient({ url, token })` from
`@sheavly/client/client/client.helper`, with `readEntries` for the streams.

# How Sheavly is shipped

Sheavly is meant to be installed with one command, to run one backend per user as an always-on
service, and to let any front end connect to it. This page records how that is decided. The rest of
the docs describe what exists; this one also records what is decided and not built yet. Sections
that describe something not built say "will", and the table says which entries are built. When an
issue below lands, its entry changes from decided to built and points at the doc that describes it.

The work is tracked as one feature, [#387](https://github.com/Sheavly/harness/issues/387), with a
sub-issue for each piece. Where this page decides something the sub-issue does not yet say, the
section says so, and the sub-issue must be updated to match.

Publishing to npm is on hold: the first public release waits. What comes first is the work that
changes how Sheavly runs, the always-on server, the `sheavly` command and the service, because
the rest is built on it. The publishing decisions below are kept so they are not lost, and they
wait with it.

## What is built today

- **The backend serves many conversations at once** over HTTP, on `127.0.0.1` by default (port
  4310, which moves to a free port when it is taken, with a line on stdout before `→ listening on`
  saying so; a port asked for with `SERVER_PORT` never moves, so a front end reads the discovery
  file for the port and does not assume 4310), and every route needs a bearer token (see [the API](../apps/backend/docs/api.md)). A
  second front end can follow a conversation that is running, through its stream route.
- **A terminal can connect to a running backend** with `BACKEND_URL` and `BACKEND_TOKEN`, and
  otherwise starts its own on a free port with a token it makes, which stops when the terminal
  does (`SERVER_EXIT_WITH_PARENT`). That is the development mode and it stays.
- **Closing a conversation stops its prompts, tasks and processes.** The backend closes every
  conversation when it is stopped by a signal or when the front end that started it goes away, not
  when it crashes or is killed. The terminal closes its conversation when it exits normally.
- **The user's data** is under `~/.sheavly` (`SHEAVLY_HOME` moves it): profiles, models, keys,
  conversations, trust and settings (see [storage](../packages/storage/docs/design.md)).
- **The protocol has a version.** It is a semantic version, the version of the `@sheavly/protocol`
  package, in one place: the contract files, the backend and the client all read that value. Two
  versions are compatible when they are on the same breaking line (the same major from 1.0.0, the
  same major and minor below it); a patch difference always is. When they are not, the message says
  which side is older and what to do.
- **Two routes answer without a token:** `GET /health` (only that the server is up, its server
  version and its protocol version) and `QUERY /handshake` (a proof, under the token, of a nonce,
  the instance id and the protocol version). Every other route still needs the token, and the
  contract marks the two with `public: true`.
- **The client can verify a server** before it trusts it: `verifyServer` in `@sheavly/client` asks
  the handshake with a fresh nonce, through a client that has no token and so cannot send one,
  and checks the proof. The token is in no request it makes. The finder below takes it as an
  injected function, and `sheavly chat` passes it. The server makes its instance id at each start
  and writes it in the discovery file.
- **The discovery file and the one-server lock are built, and the backend uses them.** The library
  is in `@sheavly/storage` (and the file's schema in `@sheavly/protocol`): a writer, a safe reader
  of one folder, a lock held as a listening socket, and `ServerPresence`, which orders them and
  turns every failure but "another live server holds the lock" into a warning. A backend that is
  always on (not `SERVER_EXIT_WITH_PARENT`, and not `SERVER_DISCOVERY=false`) takes the lock once
  its settings are checked and before it listens, prints or writes anything, refuses to start
  when another server holds it, and writes the file once it listens.
- **A finder for the running server is built, and `sheavly chat` uses it.** `findRunningServer`
  (`@sheavly/storage`, `server-finder/`) looks in the runtime folder and then the home folder,
  reads the file through the safe reader, asks the lock (`probeServerLock`) whether a server
  holds it, and only then calls the handshake, which is passed in as a function because a library
  package may not depend on `@sheavly/client`; an app passes `verifyServer`. It returns the token
  only for a server that proved it holds it, and it reads and probes only. It is covered by tests
  with real servers and real listeners. `sheavly chat` calls it; `sheavly doctor`
  ([#392](https://github.com/Sheavly/harness/issues/392)) and `sheavly connection`
  ([#414](https://github.com/Sheavly/harness/issues/414)) will. Every workspace but the server
  reaches the server only through it, with `verifyServer`: `harness/server-through-finder` fails
  source that imports the discovery file, the lock or the runtime folder directly, or calls the
  finder without `verify: verifyServer`. `connectBackend` and
  `npm run dev:terminal` **never read the discovery file**, and a lint restriction keeps
  `connectBackend` from importing the finder; `BACKEND_URL` and `BACKEND_TOKEN` skip the file as
  before.
- **A terminal's `--trust` reaches a backend that was already running.** When the terminal only
  connected (`BACKEND_URL`), it sends the trust request for its own folder before its conversation
  starts, and the conversation opens in that same folder, so what is trusted is what runs; a
  backend it started already got `--trust` as its own flag. A refused or failed request is
  reported, naming the folder and never the token, as one line of at most 200 characters; a
  backend that does not answer in 10 s fails the start.
- **The `sheavly` command exists and runs from the checkout** (`apps/sheavly`, the one workspace
  named `sheavly`): `npm run sheavly -- --version`, `--help`, `serve`, `chat`, `setup` and
  `doctor`, or `node apps/sheavly/dist/cli.js` after `npm run build`. It imports the backend's
  `runServer` and the terminal's `runTerminalChat` and `runTerminalSetup` in its own process, through the launcher exception to "nothing imports an app" (`sheavly.launcher`, limited to the
  apps and entry files `LAUNCHER_ENTRIES` lists; see the layout doc in `@sheavly/eslint-config`). `serve`
  starts the server exactly as `npm run serve` does (the same settings, lock, discovery file,
  output and stop), and `chat` runs the terminal on the user's running server, found through the
  discovery file and proven by its handshake before the token is used; with none it says so, says
  to run `sheavly serve` in another terminal and starts nothing, and `BACKEND_URL` and
  `BACKEND_TOKEN` still name a server instead. `setup` runs the terminal's setup wizard on that
  same verified server and ends (it ignores `BACKEND_URL`, since it sends a provider key), and
  `doctor` reports what is installed, what runs and what is wrong.
  The package is not packed or installed yet ([#450](https://github.com/Sheavly/harness/issues/450)),
  and `update` is not built.
- **Every package is private at version `0.0.0`** and is consumed from source inside this repository.

## Decisions

| Decision                                                                                      | Status            | Built by                                                                                                     |
| --------------------------------------------------------------------------------------------- | ----------------- | ------------------------------------------------------------------------------------------------------------ |
| The npm scope is `@sheavly` and the command is `sheavly`                                      | decided           | [#82](https://github.com/Sheavly/harness/issues/82), [#392](https://github.com/Sheavly/harness/issues/392)   |
| Each package has its own version, released with changesets                                    | decided           | [#396](https://github.com/Sheavly/harness/issues/396)                                                        |
| Every package is public except `@sheavly/eslint-config`; `dist/` and docs only                | decided           | [#82](https://github.com/Sheavly/harness/issues/82)                                                          |
| `sheavly` is a thin package that runs the backend and the terminal                            | decided           | [#392](https://github.com/Sheavly/harness/issues/392)                                                        |
| One backend per user, always on, that every front end connects to                             | decided           | [#390](https://github.com/Sheavly/harness/issues/390), [#393](https://github.com/Sheavly/harness/issues/393) |
| A conversation outlives its terminal, and `--resume` attaches and replays it                  | decided           | [#399](https://github.com/Sheavly/harness/issues/399), [#392](https://github.com/Sheavly/harness/issues/392) |
| `sheavly chat` starts the installed service, or says how to install it                        | decided           | [#392](https://github.com/Sheavly/harness/issues/392)                                                        |
| Which extensions load is chosen per workspace, fixed when a conversation starts               | decided           | [#400](https://github.com/Sheavly/harness/issues/400)                                                        |
| Unattended work has no cap; the server sends a desktop notification if enabled                | decided           | [#401](https://github.com/Sheavly/harness/issues/401), [#399](https://github.com/Sheavly/harness/issues/399) |
| The first public release is on hold                                                           | decided           | [#82](https://github.com/Sheavly/harness/issues/82), [#396](https://github.com/Sheavly/harness/issues/396)   |
| A front end finds it through a discovery file, and verifies it before trusting                | decided           | [#390](https://github.com/Sheavly/harness/issues/390)                                                        |
| The server listens on loopback and every route needs a token, except health and the handshake | built today, kept | [the API](../apps/backend/docs/api.md)                                                                       |
| The service is a systemd user unit on Linux first                                             | decided           | [#393](https://github.com/Sheavly/harness/issues/393)                                                        |
| Node 24 and up; Linux is the first and only tested system                                     | decided here      | [#393](https://github.com/Sheavly/harness/issues/393)                                                        |
| Stored data is versioned and migrated on upgrade                                              | decided           | [#391](https://github.com/Sheavly/harness/issues/391)                                                        |
| The backend's own settings come from the settings files                                       | decided           | [#389](https://github.com/Sheavly/harness/issues/389)                                                        |

### Names

Packages are published to npm under the `@sheavly` scope, and the command a user runs is
`sheavly`. The scope is an npm organization and the `sheavly` name is a package; both belong to the
project's maintainer. Reason: one scope keeps the packages together and stops others publishing
packages that look like ours under it.

### Versions and releases

Each package has its own version, so a package that did not change is not released again. Reason:
the packages change at different rates, and a release that bumps everything hides which change
matters.

A change to a published package will carry a changeset: a small file that names the packages it
changes, how (patch, minor or major) and one line for the changelog. A release workflow will collect
them in a "Version Packages" pull request that bumps the versions, rewrites the ranges of the
packages that depend on them and writes a changelog for each; merging it publishes. Prereleases go
to a `next` tag by entering the changesets prerelease mode, scoped packages are published with
public access, and packages are published from CI with npm provenance, after an approval. Below
1.0.0 a minor version may break, as semantic versioning allows.

### Which packages are public

Every workspace is published except `@sheavly/eslint-config`, which is this repository's own
tooling. `@sheavly/testing` is public so that authors of extensions can use its fakes. All the
other packages, including the two apps, `@sheavly/backend` and `@sheavly/terminal`, and the
built-in extensions, are public so that a downstream front end can use the backend as a library. A
published package contains `dist/` and its docs, and no source, tests or fakes. Reason: this is the
point of the layers: another project can build on a part without taking the rest.

Once a version is published it is permanent: a number can never be reused, a bad release is fixed
by a new version and a deprecation, and the extension contract is public from the first release of
`@sheavly/extension`. [#82](https://github.com/Sheavly/harness/issues/82) lists the eslint config as
public and leaves the registry open, and must be updated to match this page; it must also give the
two apps and `@sheavly/testing`, which have no `prepack` or `files` yet, the same setup as the
libraries.

### The `sheavly` package

`sheavly` is a thin package: its command imports the backend and the terminal, and will depend on
the built-in extensions, `@sheavly/agents`, `@sheavly/coding` and `@sheavly/web`, once something
in the command composes them (today the backend does, and an unused dependency fails the dead-code
check). It holds the command line and nothing else, so that the backend and the terminal stay
usable on their own. It is built as the workspace `apps/sheavly`, the one launcher: the layout
lets exactly that workspace depend on apps, and the backend and the terminal export only the entry
files it runs (`runServer`, `runTerminalChat`, `runTerminalSetup`). This is a decision of this page, and
[#392](https://github.com/Sheavly/harness/issues/392) must be updated to match.

### One backend per user

The backend will run once per user and keep running without a terminal. Every front end, the
terminal now and an editor later, connects to it. Reason: the user's data, models and keys are
per user, so one process owns them and every front end sees the same conversations. A tool server
such as an MCP server may also need credentials or a sign-in, and those belong in one place that
every front end uses, not in each terminal.

### Starting it

`sheavly chat` looks for the server through the discovery file, with the finder (see "The
discovery file"). Until the service exists, when none is running it says why for each folder it
looked in and tells the user to run `sheavly serve` in another terminal, and starts nothing. Once
the service exists, when none is running and the service is installed, it starts the service.
When the service is not installed it says so and tells the user to run `sheavly service install`; it does not start a private server of its own, so there
is one server and nothing is lost when a terminal closes. That the first command a new user runs
ends in an instruction is deliberate. A discovery file whose process is gone, whose lock is free
or whose handshake fails counts as no server, and the client does not send the token to it (a
server that relays the handshake to the real one is the exception, see "The boundary"). When the
service is installed but does not start, `sheavly chat` waits for the handshake, then says so and
where the log is, and still does not fall back to a private server. Where the service is not
supported, which is macOS and Windows until their service exists, it says so and points to
`sheavly serve` in another terminal. A development checkout can still start a backend per
terminal, as it does today.

### Which extensions load

Today a conversation gets the extensions its caller passes. With one server per user, which
extensions a conversation gets is decided per workspace, so a user installs extensions once and
chooses which of them each folder loads. What a project asks for is read from its own `.sheavly`
folder, and an extension adds code, so a project's choice is honoured only in a trusted workspace.
The choice follows the three layers the extension settings already use: the user's global choice,
then the profile's, then the workspace's, and a stronger layer wins. A repository can add an
installed extension the user did not turn off, and can never turn off or replace one the user
chose. A project's entry from a workspace that is not trusted is ignored and reported with its
reason, never silently used. A project can only name extensions the user has already installed: a
name that is not installed is reported and skipped, and never causes a download, an install or a
prompt to install, which only the user's own `sheavly extension` commands do.

The set is fixed when a conversation starts: removing or disabling an extension while a
conversation is live changes nothing for that conversation, and takes effect in the conversations
started afterwards. A conversation records the extensions it started with, by name and version. One
the server reopens loads that recorded set again, so the tools in its history still exist, and
also picks up the extensions its workspace's choice now includes. A recorded extension that is no
longer installed is reported and the conversation reopens without it; what a reopen does with an
extension the user has since turned off is decided by the issue that builds this. A sub-agent
loads the set its parent started with, or a subset of it, never a set resolved later. The install
location and the file where a workspace chooses are decided by that issue,
[#400](https://github.com/Sheavly/harness/issues/400), which is related to
[#332](https://github.com/Sheavly/harness/issues/332), the issue that installs extensions.

### A terminal leaving and resuming

None of this is built; [#399](https://github.com/Sheavly/harness/issues/399) builds it. Today a
terminal closes its conversation when it exits, which stops the conversation's prompts, tasks and
processes, and `--resume` reopens a saved conversation from its history. With a server that stays
up that is the wrong default, so the decision is the opposite: a conversation outlives the terminal
that started it. Detaching means leaving without closing. Closing a conversation, and the server
closing every conversation when it stops, stay as they are today.

- **Exiting detaches.** Closing the terminal, Ctrl+C at the prompt and `/exit` leave the
  conversation running on the server, with its tasks and processes. Stopping it is a separate,
  explicit command, and a way to list what is running, and which of those wait on the user, keeps
  work the user cannot see from being invisible. Both are the `conversations` commands of
  [#392](https://github.com/Sheavly/harness/issues/392). A conversation that fails or is
  rate-limited while detached behaves as an attached one: the run ends and the conversation stays
  live and idle, and resume shows the outcome.
- **`--resume` attaches.** It attaches to the conversation when it is still live, rebuilds the
  screen from the replayed stream, including what happened while it was gone, and then follows it
  live. It makes no sound and repeats no side effect for what it replays. It reopens from the saved
  history only when the conversation is not live. The stream already supports this: a client can
  ask for a replay from the start, which is sent whole however long the conversation is, and
  continue after the last entry it saw. Without an id it resumes the conversation of the current
  profile with the latest activity in the real path of the current folder, and prints its id and
  title before it attaches.
- **Work that arrives while nobody is attached waits.** An approval request stays pending, with no
  timeout, and is shown on resume; the agent does not go on without it, and nothing answers it
  for the user. Today an approval is refused at once when no client is listening for approvals, so
  this is a change to the backend: a conversation an interactive front end has attached to keeps
  its approvals pending while detached, and a conversation that no approver ever attached to, such
  as a scripted prompt, keeps today's refusal, so scripts do not hang. The agent's question tool
  follows the same rule. A waiting conversation is never closed or evicted because it waits, so
  the retention of [#45](https://github.com/Sheavly/harness/issues/45) must exclude conversations
  with a pending approval or running tasks. Finished background tasks and sub-agent reports are
  delivered on resume in the order they happened, and lines the user queued while the conversation
  was live go on running in order; after a server restart the queue is shown as waiting and is not
  sent, as it is today.
- **There is no cap on unattended work.** A detached conversation runs as long as an attached one
  would, with the same limits and none added: headless runs are supported by default. A budget on
  turns or spend is a separate opt-in feature ([#59](https://github.com/Sheavly/harness/issues/59)).
  It means a detached agent can keep calling a paid model API for as long as it has work, and the
  user knows that before they close the terminal. Nothing limits how many conversations run
  detached, a loop that makes no progress runs until the user stops it, and conversation storage
  grows until retention ([#45](https://github.com/Sheavly/harness/issues/45)) removes finished
  ones. The list of running conversations shows what each has cost so far, from the usage it
  already reports, and resume shows the total.
- **The server can notify the user.** A terminal that is closed cannot say that a conversation
  needs the user, so the server sends a desktop notification when a detached conversation waits on
  an approval or a question, and when it finishes. It is a setting in the settings files, and its
  default and the mechanism on each system are decided by the issue that builds it,
  [#401](https://github.com/Sheavly/harness/issues/401). It may not reach the user: it needs a
  desktop session, and a server with none, or a user connected over SSH, gets nothing and logs it
  once. A conversation's title comes from a prompt or the model and can hold a secret, and a
  notification can show on a lock screen or stay in a shared history, so the text is fixed wording
  and the conversation's short id, never the title, command output or file contents.
- **A server restart is shown in the chat.** Stopping or restarting the server stops what was
  running, which cannot be recovered. Resume then reopens from the saved history, and the server
  writes a notice into that history, once and at that point, so every front end shows the same
  transcript. It says that the server restarted and lists what did not survive: running tasks,
  sub-agents and processes, and a pending approval.

### The discovery file

The file and the lock are built as library code and the backend uses them, and the protocol
version, the two token-free routes, the client's verification and the finder that reads the file,
described below, are built. `sheavly chat` calls the finder, the other `sheavly` commands will
([#392](https://github.com/Sheavly/harness/issues/392),
[#414](https://github.com/Sheavly/harness/issues/414)), and the terminal's `connectBackend` and
`npm run dev:terminal` never do.

The always-on server (`npm run serve -w @sheavly/backend` today, the service later) writes a file
that holds a format version, the server's URL, its token, a random instance id made at each start, its process id, its
own version and the protocol version it speaks. A front end reads it to connect, so nothing is
passed by hand. A backend a front end starts for itself, as the terminal does in development,
takes no lock and writes no file, so it can never replace the real server's.

- **Where (built).** In `$XDG_RUNTIME_DIR/sheavly/<hash>` when that variable is set and the folder
  can be made private, otherwise in the home folder itself, and the file and the lock socket live in
  the same folder. `<hash>` is 12 characters of a hash of the real path of the home folder, so two
  homes under one runtime directory never share a file or a lock and a symlinked home is one
  server. There is no fallback under `/tmp`, where another user could plant the name. The runtime
  directory is private to the user and cleared at reboot, and it outlives a logout while the
  service's linger is on, so a stale file in it does not survive a reboot. The home folder is not
  cleared: a stale file or socket left there by a killed server stays until the next server
  replaces it. A home folder on a network
  drive may not enforce file modes, which is why the runtime directory is preferred. Only
  `serverRuntimeDirectory` reads the variable; `harness/no-discovery-path` fails any other source
  file that names it or the file.
- **How it is written and read (built).** Created with mode `0600` under a temporary name made
  with `O_EXCL` and renamed into place, so it is never world-readable and never half-written, and
  never written into a folder that is not the user's private one or over a folder; a stale link
  or FIFO at its name is replaced by the rename, which does not follow a link. It holds a URL that
  is `http:` or `https:` with no login in it and a token of 32 to 512 plain characters, so a valid
  file always fits the reader's 4 KB cap. A crash can leave a `0600` temporary file holding the
  token, which the next publish or removal sweeps. The reader opens it without following links,
  checks the open handle and not the path, and refuses a file that is not a regular file, is not
  owned by the current user, has any group or world permission or is over 4 KB, and a folder with
  any group or world access. If the home folder is the fallback and is not private, there is no
  lock and no file, only a warning, so the one-server guarantee does not apply there.
- **How a client finds it (built; `sheavly chat` calls it).** `findRunningServer` lists
  the folders a server of the home may have published in, without creating any
  (`serverRuntimeCandidates`): the runtime folder when the variable is set to an absolute path,
  then the home folder, and uses the first that holds a valid file of a server that is really
  there. For each folder it reads the file with the safe reader, then asks the lock
  (`probeServerLock`: connect to the lock socket, never listen, unlink or change anything):
  accepted means a server holds it, refused or missing means the process is gone (a stale file),
  and a timeout or any other error is inconclusive. A stale file or an inconclusive lock is
  recorded and the handshake is never asked, so no token is handed out on doubt. Only then is the
  handshake called. The result is `found` (with the token, only after the handshake verified),
  `version_mismatch` (no token; it says which side is older, and a later folder that verifies
  still wins) or `none`, with one reason per folder: no file, a refused file with the reader's
  reason, invalid, newer format, stale, lock inconclusive, wrong server, no handshake, or no
  answer (the handshake threw or did not settle within `timeoutMs`, 5 s unless set). No reason,
  log line or message holds the exact token string or the file's text, whatever the injected
  handshake answers or throws (a `log` that throws is ignored). An encoded copy of the token (split
  or base64) that a lying handshake returns is not detected; but every text the finder takes from
  the handshake is at most 200 characters with no control or format characters, or the answer
  counts as no handshake. `describeNone` turns a `none` into the lines a command prints. The named pipe
  branch of the probe on Windows is written and not tested. What it does not do:
  - The URL's host is not restricted. A file in the user's own private folder is the user's own
    data, and the always-on server may bind elsewhere, but the finder hands the token to a caller
    who will send it to that address: a hostname there is exposed to DNS rebinding and a remote
    host would receive later token-bearing requests. Only the user can write the file (the folder
    is owner-only).
  - When two servers of one home are both live (the runtime-directory limit below), the first
    candidate, the runtime folder, wins.
  - A plain file, a directory, a FIFO or a dangling link at the lock socket path reads as free, so
    a file there is called stale.
  - A runtime path too long for a socket makes the probe inconclusive: a server in that state runs
    without a lock and is not found. There is nothing to do about it yet but a shorter home path.
  - A server whose process is stopped (SIGSTOP) still accepts into its backlog, so the lock reads
    held and the handshake then times out after 5 s: the result is `none` with no answer, and no
    token was sent.
  - A graceful stop leaves empty `sheavly/<hash>` folders in the runtime directory, with no files.
  - The worst case of a call with two candidates is about 2 × (1 s probe + 5 s handshake) = 12 s,
    shortened by `timeoutMs`.
  - The server is proven once, when it is found. A caller that keeps the token, as `sheavly chat`
    does, sends it to the same address afterwards, so if that server dies whatever takes its
    port next gets the later requests, a stream's reconnects included; the same holds for
    `BACKEND_URL` ([#461](https://github.com/Sheavly/harness/issues/461)).
  - On Windows nothing checks the file's owner or access (the reader skips them there) and any
    local user can create the lock's pipe. In a Sheavly home others can write to, someone else's
    file and pipe would pass, and their server's handshake would verify for their own token: a
    front end would send them its prompts and `--trust`, though not the user's token. The default
    home, under the user's profile, is private ([#462](https://github.com/Sheavly/harness/issues/462)).
- **One server (built).** A backend that is always on takes its home's lock once its settings are
  checked and before it listens, prints or writes anything, so a second server for the same home
  refuses to start: it prints the first one's process id, version and address (never its token)
  and exits with status 1, having listened for no requests, written no file and printed no token;
  it changed nothing but its own lock probe, a socket made briefly in the runtime folder. It
  prints the first one's details only once that server has published its file: two servers that
  start at the same moment can see the lock held before the file exists, and the loser then prints
  `A Sheavly server holds the lock at <path>; its discovery file could not be read (it has not
written one yet)`, still with status 1 and nothing on stdout. A server writes the discovery file
  only while holding the lock, once it listens,
  and the file holds the port it really listens on, which is not 4310 when that was taken (a notice
  line says so, and a front end reads the file, not a fixed port); a wildcard host, in any
  spelling the URL parser knows (`0.0.0.0`, `0`, `::`, `::0`, `::ffff:0.0.0.0`), is published as
  `127.0.0.1`. Everything that can fail on a setting is checked before the lock is taken, so a bad
  `MODEL_RETRIES` leaves nothing behind. When the server stops it removes the file first, so
  clients stop finding it, closes its conversations, and frees the lock last, so a successor cannot
  start while they close. A SIGINT, SIGTERM or SIGHUP while it is still starting removes the file
  if it was written and frees the lock, then exits (130, 143, 129) without listening, writing or
  printing anything more; a signal before any of the
  server's code runs cannot be handled by anyone. A second signal while it is stopping exits at
  once and leaves the file and the socket for the next start to replace.
  The limit: the lock and the file live in `$XDG_RUNTIME_DIR/sheavly/<hash>` when that is usable
  and in the home otherwise, so two servers started for the same home with a different
  `XDG_RUNTIME_DIR` (one set and one unset, or two values) do not see each other's lock. One
  server per home holds for processes that see the same runtime directory. A systemd service and
  an SSH shell can differ, so the service's setup should set the same variable.
  A server that exits with its parent (a terminal's own backend) or has `SERVER_DISCOVERY=false`
  builds no presence at all: no lock, no folder and no file, even while another server runs. A
  problem with the lock or its folder is a warning and the server runs without them.
- **How the lock works (built).** Node has no lock call of its own, so the lock is a listening
  unix socket in the runtime folder (a named pipe on Windows, written and not tested). The server
  listens under a temporary name and is published at the lock path with an atomic hard link, so
  the lock path never names a socket that is not yet listening and a taker never overwrites an
  existing name. The socket is `0600` and the folders it lives in are `0700` whatever the umask. A
  second server connects first, and a connection means a live server holds it. A socket that
  refuses the probe and is at least 250 ms old belongs to a holder that crashed: it is replaced
  under a short-lived guard file that carries its owner's nonce, which is treated as abandoned
  after 2 s, with a re-check that it is still the same socket, so servers starting together do not
  remove each other's live socket (measured: 150 rounds of four racing from a stale socket and an
  abandoned guard gave one winner each round). The lock never removes a socket it did not judge
  stale and never removes anything that is not a socket owned by the user, and a server that
  releases removes the lock path only if it is still the socket it published, so a successor is
  never affected. A socket that a foreign program leaves bound but never listening for more than
  250 ms looks stale and is replaced. A guard or breaker file that is not a regular file makes the
  attempt unusable at once and is left as it is. The guarantee assumes the process that holds the
  guard is not paused for longer than the 2 s limit in the few system calls between its last check
  and removing the stale socket: that gap cannot be closed, only made small. A filesystem that
  refuses hard links makes the lock unusable, which is a warning, not a failure to start. A
  process id alone is never enough, since ids are reused. A killed server leaves the file and the
  socket for the next server to replace, and the next server also removes the temporary sockets of
  processes that no longer run.
- **Verifying the server (built).** A client does not send the token to whatever answers at the
  URL, except to a process that relays the handshake to the real server (see the boundary below),
  and an instance id that anyone can fetch would not stop a process that took over a stale port
  from repeating it. Instead the client sends a fresh random nonce to the handshake route and the
  server answers with an HMAC, under the token, of the nonce, the instance id and the protocol
  version, plus the protocol version. The client computes the same value and compares it; the
  token is used only for that and is not sent, so a server that does not hold the token cannot
  pass, and the answer reveals neither the token nor the instance id. The client checks the proof
  first: only a server that passed is believed about versions, and a protocol version the client
  cannot speak then says which side is older. Only `verified` and `version_mismatch` come from a
  server that proved it, so only they may lead to sending the token. `no_handshake` (the route
  answered `404` or `401`: a server without the route, or something that is not Sheavly) and
  `wrong_server` never do, and `no_handshake` is not a verdict that the server is Sheavly: nginx
  or another app answers `404` too, and an impostor can choose to. The client reads at most 4 KB
  of a public answer, never follows a redirect on a public route and gives up on a silent server
  after 5 s, so whatever sits on a stale port cannot make it buffer without limit, judge another
  host or wait forever. The client gets the instance id from the discovery file, which the
  server writes, and the finder passes it to the check; `sheavly chat` is the first front end that
  calls the finder.
- **Two routes need no token (built).** A health route, which returns only whether the server is up,
  its server version and its protocol version, and the handshake route above. Both are marked
  `public` in the contract, and the backend's token check skips the routes the contract marks that
  way (`routeNamesByAccess`), so no list in the backend names them; neither returns a path, a
  process id or anything about a conversation. The server cuts a request that takes more than 30 s
  to arrive or more than 10 s to send its headers, since these routes read a body with no token.
- **The address (built).** The server listens on its usual default port (4310) when it is free
  and falls back to a free one when it is not, and the file always holds the address it actually
  uses. A port asked for with `SERVER_PORT` is strict: when it is taken, the server fails and
  leaves no lock and no file. `SERVER_PORT=0` picks a free one.
- **The URL is a full URL, not a port**, so another transport can be added later without changing
  the format.

### The boundary

The server listens on loopback and every route needs a token, as the backend does today. That is
built and stays, with one built exception: the health and handshake routes above.

What another local user can do with the port alone: connect and hold connections open. Every
other route, including an unknown one, answers `401` with the same body, so they learn nothing
else; from the health route they learn that Sheavly runs and which versions. They cannot call any
other route without the token, which is compared in constant time. On a machine shared by several
users that is weaker than it could be, because file
permissions would stop a connection and only the token stops it here. The handshake stops a process
that took over a stale port, which cannot answer it, but not one that sits in front of a live server
and relays the challenge and the answer, which then receives the token. A unix socket in the user's
runtime directory would use permissions instead, and the discovery file allows it. It is not part
of this work and has no issue yet; it is recorded here as a known weakness, not as something
solved.

What a web page can do: reach the port, but not read the token and not send an `Authorization`
header without a cross-origin preflight, which the server answers with `401`. The server has no
`Origin` or `Host` check; the token is the only defence, and a check that allows only the server's
own host names and refuses a request that carries an `Origin` would be a second one. Without a
`Host` check, DNS rebinding works: a page whose name is made to resolve to the loopback address
reaches the two public routes as if it were same-origin, and can read their answers. They are
public anyway, and from there the page still cannot call a private route without the token.

A server reachable from other machines is planned, but not for a while. Until then a terminal on
another machine can use `BACKEND_URL` and `BACKEND_TOKEN`, which it already accepts, with a port
forwarded over SSH to the server's loopback address. The routes that set up credentials and trust
keep working that way, because the server's check looks at the address it is bound to and not at
the client.

### Trust

What trust means does not change. `--trust` and the trust store behave as they do today, and trust
given from one terminal applies to every front end from then on.

Two things follow from sharing one server. Trust is recorded per folder, and any front end that
holds the token can grant it, with no consent of its own. And `--trust` on the server records trust
for every folder with hooks or settings under `.sheavly/` that any conversation opens, for as long
as the trust store keeps the record, which is until that folder's `.sheavly/` changes: a server
started with it trusts a repository the moment someone opens a conversation in it, and the trust
stays after the flag is gone. It is not for the service, and the service command will refuse it.
A terminal that connects to a backend that is already running (`BACKEND_URL`) sends its `--trust`
to the trust route for its own folder before its conversation starts, and opens the conversation
in that same folder (it does not leave the choice to the backend's own default), which gives the
user the same result as a backend it started itself; before that, the flag was dropped in that
case. With `--resume` the folder is trusted but the resumed conversation runs in its saved
folder, so "what is trusted is what runs" holds for new conversations only. A backend the
terminal started is not sent it again. A refused request is reported with the folder named and
never the token, cut to its first line and 200 characters (hidden entirely when it echoes any 8
characters of the token), and a backend that
does not answer within 10 s fails the start. The one exception is the demo, which names no
folder: when the backend refuses its folder as a workspace (the home folder, say), the demo says
so and runs in the backend's own folder, untrusted, as it did before `--trust` reached a running
backend.

Two more follow from a conversation that outlives its terminal. A detached conversation keeps the
permissions it had: commands the user allowed always, or allowed everything in that folder, keep
running with nobody watching, on a server that lives for months, and only a request that is not
already allowed waits. The terminal warns when it detaches from a conversation that allows
everything, and the list of running conversations shows which wait on the user. And any holder of
the token can read any conversation's stream, which carries command output and file contents the
user saw, and attach to it. One token is one user, and sharing a token is not supported. A second
terminal attached to the same conversation is allowed: the first answer to an approval counts, and
a later one is refused.

### The service

On Linux the server will be installed as a systemd user unit that restarts on failure, writes its
log to the journal and keeps running after the user logs out. Reason: the server runs as the
user, with the user's keys, so it is a user unit and not a system one. macOS (a launch agent) and
Windows (a task that starts at logon) follow and are not part of the first release. A command,
`sheavly service`, installs, starts, stops and removes it.

The service is not a terminal, so the token is never written to the journal. The server prints its
token today when none is set; `sheavly service install` will instead make the token once and store
it in a file that only the user can read, which the unit passes to the server as a credential and
not as a line of the unit file, where `systemctl show` would print it. The discovery file carries the
same token. The token also
lives much longer than it does today, where it ends with the terminal, and a leaked copy is
persistent command execution as the user. There is no way yet to rotate it or revoke a copy short of
restarting the server, which is a known gap.

### Platforms

Node 24 and up, which the repository already requires. Linux is the first supported system and the
only one tested for the first release. This is a decision of this page.

### Updating

`sheavly update` restarts the server, which stops the conversations that are running, so it
refuses, or asks first, when work is running or a conversation waits on the user, unless the user
tells it to go on, and the restart is
shown in the chat history of each conversation it stopped. A version of the terminal and a version
of the server that cannot speak to each other say which is older and what to do: the check that
finds it is built (the protocol version is semver, and the client's verification reports it), and
the terminal will show it. How an update
finds a new release is open, and it is a network call, so it is off unless the user turns it on.

### Privacy and support

Sheavly collects and sends no telemetry. What leaves the machine is what the user asked for:
requests to the model providers they configured, and the agent's own web tools, which contact the
search backends and the sites the agent is told to read and can be turned off (`WEB_SEARCH` and
`WEB_FETCH`). An update check is opt-in. Until 1.0 only the latest release of each package is
supported, and fixes go there.
A `SECURITY.md` that says where to report a vulnerability privately and which versions get fixes
comes first of the repository's policy files, with a contribution guide and a code of conduct; no
sign-off or contributor agreement is required, and the license is the grant. None of these files
exists yet; [#402](https://github.com/Sheavly/harness/issues/402) adds them.

### Stored data

Every stored format will carry a version and be migrated when a newer release starts. Until 1.0 a
format may change, always with a migration that keeps the original until the new form is written.
A migration keeps the original's file modes, never logs a value, and writes to a temporary file that
is renamed into place. Data written by a newer release than the one running is refused and left
untouched, so an older release never rewrites it.

### Publishing

Publishing runs code as the user on every machine that installs it, so the release is part of the
security of the product. The first public release is on hold, and these steps wait with it. None of
the steps below is built; they are what
[#396](https://github.com/Sheavly/harness/issues/396) and [#82](https://github.com/Sheavly/harness/issues/82)
implement.

- **Accounts.** Two-factor authentication on the npm organization and on every maintainer, with
  recovery codes kept, and a second owner so the organization is not lost with one account.
- **No long-lived token.** After a package's first release, it will be published from the release
  workflow with npm trusted publishing, so no npm token is stored, and the package's publishing
  access will refuse tokens. Trusted publishing is configured on an existing package, so the first
  release of each package is made once by hand with two-factor authentication. The workflow needs
  permission to request an identity token, a current npm and Node, and a public repository for
  provenance, and the trusted-publisher entry names the protected environment that requires approval.
- **No install scripts.** No package has an `install` or `postinstall` script today; the only script
  that runs on packing, `prepack`, runs on the maintainer's machine. A check on the packed packages
  will keep it so.
- **Look-alike names** outside the scope cannot be prevented, so the guide will tell users to
  install `sheavly` and the `@sheavly` packages and no others.

## Left open

- The boundary becoming a unix socket, and a named pipe on Windows. No issue yet.
- How `sheavly update` finds a new release: [#392](https://github.com/Sheavly/harness/issues/392).
- Whether a Windows service is needed instead of a logon task:
  [#395](https://github.com/Sheavly/harness/issues/395).
- Rotating and revoking the token. No issue yet.
- A server that other machines can reach: planned, not for a while.
- A hosted marketplace for extensions: not planned.
- Whether the first public release keeps the extension contract at `0.x` and unstable, or waits for
  [#107](https://github.com/Sheavly/harness/issues/107), decided when the release is no longer on
  hold.

# Design

How the command line works inside, why it is built this way, and how to extend it.

## The launcher

`sheavly` is the product's command, so it has to start the apps (the backend's server, the
terminal's chat). The layout normally refuses any dependency on an app; this workspace is the one
exception, marked `sheavly.launcher: true` in its `package.json` (set with `npm pkg set`) and named
`sheavly`, unscoped. The flag is allowed on this workspace only, and loosens no other rule: the
launcher is itself an app, so nothing depends on it. It may depend only on the apps
`LAUNCHER_ENTRIES` (in `@sheavly/eslint-config`'s `layout.js`) lists, and they export the entry
files that list names and no others (`@sheavly/backend/run-server/run-server.helper`,
`@sheavly/terminal/chat/start.helper`, `@sheavly/terminal/chat/chat-failure.helper` and
`@sheavly/terminal/setup/run-setup.helper`, plus the backend's server-process fake and its types
for the tests): the layout check fails any other edge
or export, and a `main`, `module` or `browser` on an app, and lint fails an import of anything
else of theirs, their bare names included.

## The command table

`cli.ts` is the only file that touches the process: it works from `INIT_CWD` when npm set it,
builds the table of commands and calls `dispatch`, which takes the argument vector, the
environment, the commands, the streams it writes to and how to read the version, and returns the
exit code. Tests call it with fakes; `cli.ts` never calls `process.exit`, because a server that
listens must keep the process alive, and a chat that failed has already set its own exit code.

From the checkout, `npm run sheavly` runs `cli.ts` through tsx with `tsconfig.source.json`, which
includes every workspace's `src`: tsx applies a tsconfig only to the files it includes, and the
terminal's components need its JSX setting (`tsconfig.json` covers this workspace alone, and they
failed with "React is not defined"). `source-jsx.processes.test.ts` holds that for every `.tsx`.
The build compiles each workspace with its own config, so `dist/` needs none of this.

| Exit code | When                                                                     |
| --------- | ------------------------------------------------------------------------ |
| 0         | A command ran (a server resolves once it listens), `--version`, `--help` |
| 1         | A command failed, a server setting or argument included: one line        |
| 2         | What was typed is wrong: an unknown or missing command or option         |

An error never prints a stack, unless `SHEAVLY_DEBUG` is set to anything but the empty string.
A command is `{ name, summary, help, run }`; `--help` lists the table's names and summaries, and
`<command> --help` (or `-h`, anywhere after the command) prints that command's `help` and runs
nothing, so a command that is not in the table is not listed. It errs towards help: a first
message holding `-h` as a word of its own needs quotes (`chat "what does ls -h print"`), while
stopping at the first word would also stop at an option's value (`chat --profile <id> --help`)
and send `--help` to a paid model. A failure's message is put on one line, even one printed over
several (a settings error lists its issues).

## The commands

- **`serve`** runs `runServer({ env, args })` of the backend in this process, so its settings,
  lock, discovery file, output and stop are those of `npm run serve`
  ([serving](../../backend/docs/serve.md)). It passes its arguments on and keeps no list of its
  own: the server refuses one it doesn't read before anything starts, so `serve --version` exits
  1 with the server's one-line message and starts nothing.
- **`chat`** finds the user's running server and runs `runTerminalChat({ env, args, server })` of
  the terminal on it, handing a failure to the terminal's `reportChatFailure`, so it ends with
  the same message and exit code (130 for a cancelled setup, 1 otherwise). `findVerifiedServer`
  (`chat/find-server.helper.ts`; `findChatServer` narrows it to the url and token, all that
  `chat` and `setup` pass on) calls `findRunningServer` of `@sheavly/storage` with
  `verifyServer` of `@sheavly/client` as the handshake: the file is read through the safe reader,
  a free lock means the file is left over and nothing is contacted, and the token is handed on
  only after the server proved it holds it. With none it exits 1, saying why for each folder it
  looked in and to run `sheavly serve` in another terminal; a server of another protocol is
  refused with which side is older. Neither message holds the token, and it never starts a
  server. A non-empty `BACKEND_URL` skips the file, and the terminal connects to that server with
  `BACKEND_TOKEN`, which it requires; `BACKEND_TOKEN` alone changes nothing. The terminal sends
  `--trust` to the found server's trust route for its folder, as it does for `BACKEND_URL`.

  Two gaps are known. The server is proven once, when it is found: if it dies mid-chat,
  whatever takes its port next gets the later requests with the token, a stream's reconnects
  included, as with `BACKEND_URL` ([#461](https://github.com/Sheavly/harness/issues/461)). And on
  Windows nothing checks the discovery file's owner or access, and any local user can create the
  lock's pipe, so the Sheavly home must not be a folder others can write to: there, someone
  else's server could pass the handshake and get the chat's prompts and `--trust`, though not the
  user's token ([#462](https://github.com/Sheavly/harness/issues/462)).

  A launcher in another repo (the tmux client) that must know which conversation each of its chats
  is creates the conversation through the API and starts `sheavly chat --resume <id>`: the chat
  joins a live conversation as it is and starts no other, so the launcher holds the id before the
  chat exists and `sheavly` adds no flag or file for it
  ([the terminal's doc](../../terminal/docs/chat.md#a-chat-on-a-conversation-another-program-created)
  has what a launcher must know: one chat per conversation, since the chat's end closes it; the
  folder and profile are fixed at creation; and trust the folder before creating the
  conversation, since hooks load then). `chat/__tests__/resume-live.processes.test.ts` pins it,
  with two chats started at once in one folder.

- **`connection --json`** prints how to reach the user's running server as one line of JSON on
  stdout, for a front end in another repo (the tmux client) that must not read the home folder or
  repeat the safe read of the discovery file:
  `{ source: "discovery", url, token, protocolVersion, serverVersion }`. The server is found by
  `findVerifiedServer`, the lookup `chat` and `setup` use (`doctor` calls the finder itself, to
  report on it), so a stale file, an impostor listener
  and a server of another protocol are refused as they are there: nothing on stdout, one line on
  stderr, exit 1, and never the token. It starts nothing and never contacts a server whose lock
  is free; the two known gaps of `chat` apply to it. With `BACKEND_URL` and `BACKEND_TOKEN` set it
  prints those as `{ source: "environment", url, token }` and contacts nothing: the handshake
  proof is bound to the server's instance id, which only the discovery file holds and no route
  returns (a route that returned it would let whoever learns it test guesses of a weak token
  offline), so an address given by hand cannot be verified, and `source` tells the caller which
  connection it got, and a caller must treat `environment` as unverified. The address is printed
  as given. A `BACKEND_URL` that is not an `http://` or `https://` URL written as one word (no
  space, control or invisible format character, no backslash) and with no login in it
  (`http://127.0.0.1@evil.example`: a person reads the first host, a client connects to the
  second), or has no `BACKEND_TOKEN`, is an error naming the variable and never repeating a value;
  those are the forms a URL parser reads differently from another, or that hide what a terminal
  shows. `BACKEND_TOKEN` alone is ignored, as for `chat`. The output is the token, written to
  stdout in that one line and nowhere else. It refuses to write to a terminal, before it looks
  for anything (exit 1, saying to pipe it to the program that reads it): a token printed there
  stays in the scrollback, and a program that reads the line reads a pipe. `cli.ts` passes
  whether stdout is a terminal, since the command's folder may not read `process`, so a test of
  the refusal is a unit test of the command; the process tests write to pipes. `--json` is
  required, once and with nothing else (any other argument is a usage error, exit 2, and is not
  echoed), so running it says what it prints. A program should run
  `node apps/sheavly/dist/cli.js connection --json`: `npm run` may print its own banner before
  the line. `connectionConfinement` (`@sheavly/eslint-config`, spread into this workspace's
  config) keeps `src/connection/` from importing the backend, the terminal, the client, a network
  module, `process`, `console`, `module` or the process runner, from using `fetch` or `console`,
  and from writing with `process.stdout`: it starts and contacts nothing itself, the lookup
  `cli.ts` passes in does, and it writes only through its streams. It does not see a dynamic
  `import()` or `createRequire`. That the token goes into no message is held by tests:
  `connection.processes.test.ts` runs the real command on a real server and on the planted
  left-over file, impostor and other-protocol cases of `chat`'s tests, and searches stdout and
  stderr of each refusal for the token, with `SHEAVLY_DEBUG` set as well.

- **`service`** runs the server as a systemd user service on Linux: `install`, `uninstall`,
  `start`, `stop`, `restart`, `status` and `logs` (`service/`, see
  [the service](../../../docs/shipping.md#the-service)). Every program it runs (`systemctl`,
  `loginctl`, `journalctl`) is started by name with an argument array through the injected
  `SystemTools`, never a shell line, so a test plays systemd with `testing/system-tools.fake.ts`
  and the unit tests touch no systemd: `systemdConfinement` (`@sheavly/eslint-config`, spread
  into this workspace's config) fails an import of `node:child_process` in `src/service/`
  outside `system.helper.ts`, and an import of `system.helper` anywhere but `cli.ts`, so a test
  cannot get the real tools by importing them. That is not a guarantee about every test: one
  that starts the real command line reaches the real systemd for an action that gets as far as
  asking it, and `service.processes.test.ts` therefore runs refusals only, which is held by
  review. It refuses before it asks or writes anything: off Linux, with no systemd
  user manager (`systemctl --user show-environment` fails), from source (the unit runs the built
  `dist/cli.js`, so any entry not named `cli.js` is refused with "build first"), with `--trust`
  (a server-wide `--trust` trusts every folder with hooks or settings that any conversation
  opens), and with a `PATH` that is empty or has an empty or relative entry, since the `PATH` of
  the installing shell goes into the unit for an always-on server and every command an agent runs.
  `install` says what it will do, `PATH` included, and asks (`--yes` skips the question and is the
  same for a person and for an agent's own shell, so the question is the only guard: it is not a
  barrier against a prompt-injected agent, which could also write a unit by hand), then writes the
  token file and the unit through `@sheavly/storage` (`writeTextFile`: atomic, private), turns on
  linger, enables and starts (it says systemd was asked to start it, not that it runs: a server
  that cannot start, such as one that finds another holding the home's lock, exits 1, and the
  unit's start limit stops the retries after five failures in five minutes). The home is made
  absolute, since systemd reads the unit from another folder. The
  token is made once (32 random bytes, base64url) and kept in `service.env` in the Sheavly home,
  mode 0600, which the unit reads with `EnvironmentFile`: `renderUnit` takes no token, so no unit
  it renders can hold one, and `systemctl show` and the journal never do. An existing token file
  is kept (installing again changes no token), but refused, not replaced, when others can read it
  or it is not one this command wrote. The unit sets the installing shell's `PATH` and
  `SHEAVLY_HOME`, and installing again refreshes them; it does not restart a running service (that
  would stop conversations), and says `restart` applies a changed unit. The unit names `node` by
  the path of the installing process, so a node moved or upgraded (nvm, volta) needs `install`
  again. A path or setting with a line break is refused when the unit is rendered, `%` is escaped
  everywhere and `$` in `ExecStart=` only (`Environment=` does not expand it). `uninstall`
  disables and stops, then removes nothing unless `is-active` says `inactive` or `failed` (a stop
  that outlasts the time limit here leaves `deactivating`, and a call that timed out says
  nothing), removes the unit, and removes `service.env` only when it is a token file this
  command wrote; it leaves the user's data and linger, saying how to turn linger off. It works
  on this shell's `SHEAVLY_HOME`. `start` and `restart` first run `reset-failed`, since a server
  that kept failing is `failed (start-limit-hit)` and systemd refuses to start it until that is
  cleared. `status` prints installed, enabled, running and linger, and exits 1 when it is not
  installed or not running. `system-result.utils.ts` maps how a program ended (not installed, an
  exit code, a timeout) to a result, and is tested on its own because the systemd check and
  `uninstall` rest on it. `service.helper.test.ts` runs every action against
  real files and the fake systemd; `service.processes.test.ts` runs the real command for the
  refusals that never reach systemd. What no test here can show, that the unit really starts the
  server and that it survives a logout and a reboot, takes a Linux machine with systemd and is
  checked by hand.
- **`setup`** runs the terminal's setup wizard on the running server and ends, with no
  conversation: the first profile, a model and its key, or another of each later. It is the
  wizard `chat --setup` opens (`runTerminalSetup` of the terminal, `setup/run-setup.helper`), not
  a second prompt flow: the same questions, the same setup routes, the key typed without echo and
  sent to the server's credential route only. The server is found as `chat` finds it (the finder
  and its handshake). With none running at all and a terminal to ask in it starts a short-lived
  server of its own (see "No server" below); with none and no terminal it exits 1, saying why
  and to run `sheavly serve`, and with a server and no terminal it exits 1 saying so. Unlike
  `chat` it ignores
  `BACKEND_URL`: setup sends a provider key, and that goes only to a server that proved it holds
  the token, never to an address named in the environment (`chat --setup` still serves a
  `BACKEND_URL` server).
  Esc or Ctrl+C cancels with exit 130 and what was saved stays. Run again, it opens the same
  wizard on what exists, and nothing changes without a choice. It binds this folder
  (`WORKSPACE_ROOT`, else the current one) to the profile, as `--setup` does, and ends by saying to
  run `sheavly chat`. `setup.processes.test.ts` answers the wizard in process, by question title
  (`testing/setup-answers.fake.ts`), against a real `serve` child, then runs a real `chat` that
  gets a reply from a fake model; it searches every output for the key, and the home for the one
  file that holds it (the credential store's, not the profile, a model's settings or a
  conversation), checks the model's address is the fake one before any prompt, so the key is
  never sent to a real provider, and points `BACKEND_URL` at a recording listener to show that
  setup sends it nothing. What the scripted answers cannot show, the masking of the real
  setup screen, was checked by hand in a terminal and rests on `setup-screen.service.test.ts`.
  An error message from the server's setup routes goes to the terminal as the server wrote it;
  from reading the routes it holds field names, not values, and no test pins that.

  **No server.** What each command does with none running is decided here
  ([#473](https://github.com/Sheavly/harness/issues/473)); `docs/shipping.md` ("Starting it")
  holds the reasons for `chat`.
  - **`setup` starts a server of its own** (`startEmbeddedServer` of the backend, handed to it by
    `src/cli.ts` alone: `serverStartConfinement` fails any other import of it), for as long as the
    wizard runs: it listens on loopback only, on a port the OS picks, with a token of its own and
    whatever `SERVER_*` settings the caller has replaced, takes the home's one-server lock and
    publishes its discovery file. `setup` then looks it up with the same finder and handshake as
    any server, so the key goes only to a server that proved it holds the token, and only when
    the lookup found the address it started (any other server found after the start is not used).
    The token stays in memory between the lookup and the wizard: it is never printed or stored by
    the command. It stops the server when the wizard ends, however it ends (saved, cancelled,
    failed), and a SIGHUP, SIGTERM or SIGINT stops it too before the process ends; a server that
    will not stop never replaces the wizard's own failure, nor follows a "saved" line. It starts
    one only for "nothing runs at all" and only with a terminal to ask in: a server of another
    protocol, no terminal, or another server holding the lock (it says so and to run `setup`
    again once that one is up) start nothing. It ends by saying a chat needs a server that stays
    (`sheavly serve`, or `sheavly service install`).
  - **`chat` keeps refusing** (and so will a settings screen, which this repo has no command for
    yet), with the guided message, and starts nothing: a server a chat started would end with it
    and take its conversation, which conflicts with
    [#399](https://github.com/Sheavly/harness/issues/399).
  - **Rejected.** Option C (a server that outlives the command, without the service) is not taken
    here: it needs the detach semantics of #399 and the one-server limit of
    [#443](https://github.com/Sheavly/harness/issues/443) first. A server for `chat` (Option B
    for every command) is rejected for the conversation reason above. Option A alone (always
    refuse, but guide) leaves a first run, and a launcher's pane, with a second terminal to open.
  - **A known limit.** While `setup` runs its server, that server is findable, so a client that
    starts then (a second `setup`, which then runs its wizard on it, as `setup.processes.test.ts`
    shows, or a `chat`) uses it and loses it when the first `setup` ends. The window is the
    minutes of a first run.

  **Embedded in another front end's pane** (the tmux client runs `sheavly setup` as the one
  program of a pane): it needs a terminal, nothing else from the front end, no second terminal and
  no `BACKEND_URL` (ignored). Exit 0: saved, and one line on stdout. Exit 130: the user pressed Esc
  or Ctrl+C, what was saved stays, and no server, lock or file is left. Exit 1: it could not run
  (no terminal, a refused or unusable server, another protocol), with the reason on stderr. Exit 2:
  an argument. A SIGHUP, SIGTERM or SIGINT stops its server and ends it. It prints no token and no
  key on either stream; the wizard draws on the terminal while it runs. A server it started is
  gone with it, except when the process is killed outright (SIGKILL) or crashes: the lock is then
  free, so the finder reads what is left as stale and the next server replaces it.
  `setup.processes.test.ts` runs it in process against a real server it starts, with the wizard
  answered by question title, for the first run on a clean home, the cancelled wizard (no lock or
  file left, a server starts on the home at once), the key reaching only that server (a recording
  listener at `BACKEND_URL` sees nothing) and a setup that starts while another runs its wizard
  (it uses that server and starts none). `setup.helper.test.ts` holds the failure paths with the
  server and the lookups scripted: another address found, a server that will not stop. The exit
  code 130 itself rests on the terminal's `chat-failure.helper.test.ts` and on the check by hand
  below, since these tests reject with a plain error. The real command in a pseudo-terminal with no server was
  checked by hand, with `SERVER_HOST`, `SERVER_PORT`, `SERVER_EXIT_WITH_PARENT` and
  `SERVER_DISCOVERY` set in its environment: the wizard came up on a server findable on
  loopback, Esc and Ctrl+C ended it with exit 130, a SIGHUP ended the process (`waitpid` reported
  the signal, not an exit code, there; the in-process server's own test exits 129), and each
  left nothing in the runtime folder. No test drives the real terminal screen.

- **`doctor`** prints one line per check and exits 1 when any is wrong (the report on stdout,
  then `sheavly: N check(s) failed` through `DoctorFailedError`, which prints a stack too with
  `SHEAVLY_DEBUG` set, like any failure). It takes no argument and only reads and probes: it
  never starts or stops a server, and creates or changes nothing, which
  `doctor.processes.test.ts` holds with a listing of the home and runtime folders before and
  after. The checks, each a `Finding` (`doctor/doctor.types.ts`):
  - **Node**: `process.versions.node` is 24 or later (`engines` in the root `package.json`).
  - **Home**: the folder `SHEAVLY_HOME` or `~/.sheavly` names is a folder (a link is followed, as
    the server does), owned by the user, closed to the group and others, and writable. A home that
    does not exist yet is reported but is not a problem: a server runs without one until a profile
    is stored. A link to a folder that is gone, or a path through a file, fails. Owner and mode are not judged on Windows.
  - **Server**: `findRunningServer` with `verifyServer`, as `chat` finds it, so the same states
    come out with the finder's own reasons: running and verified, left over (the lock is free),
    refused (a file others can open, a link, another owner), not a discovery file, a server that
    did not prove it holds the token, another protocol (which side is older) or none. Only a
    running, verified server is ok; every other state fails, since the question is whether
    `chat` can connect. The line says the protocol version the handshake proved and nothing the
    file holds: never the token, the address, the pid or the file's text. It looks at the
    discovery file only: with `BACKEND_URL` set, `chat` skips the file, and the line says so.
  - **Profile**: the config names a default profile whose `profile.json` reads, through
    `ConfigStore` and `ProfileStore` (never the profile registry, which hands out keys). A profile
    folder that cannot be read is listed, by its path, and fails the check. The stores' own
    messages are not printed, since a parse or schema error quotes the file. Whether that
    profile's model and key work is the server's to say, not judged here.

  The report is the one place every line passes (`renderReport`): control and format characters
  are replaced, so a folder name from a synced home cannot inject an escape sequence or a line
  that reads as another check. A check that throws (a path that cannot be resolved, a folder it
  may not read) is a failing finding naming the kind of failure (`settleCheck`), never its
  message, so the other checks are still reported.

## Adding a command

Add a module folder with `<name>.constants.ts` (name, summary, help text) and `<name>.helper.ts`
(`create<Name>Command`, taking what it runs as a parameter so a test injects a fake), then one
line in the table in `cli.ts`. The backend's or the terminal's function it runs is exported by
the app (a new entry in its `exports`, in review).

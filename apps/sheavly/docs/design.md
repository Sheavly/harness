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
  the same message and exit code (130 for a cancelled setup, 1 otherwise). `findChatServer`
  (`chat/find-server.helper.ts`) calls `findRunningServer` of `@sheavly/storage` with
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
  and its handshake), and it never starts one: with none it exits 1, saying why and to run
  `sheavly serve`, and without a terminal to ask in it exits 1 saying so. Unlike `chat` it ignores
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

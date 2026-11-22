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
`@sheavly/terminal/chat/start.helper` and `@sheavly/terminal/chat/chat-failure.helper`, plus the
backend's server-process fake and its types for the tests): the layout check fails any other edge
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

## Adding a command

Add a module folder with `<name>.constants.ts` (name, summary, help text) and `<name>.helper.ts`
(`create<Name>Command`, taking what it runs as a parameter so a test injects a fake), then one
line in the table in `cli.ts`. The backend's or the terminal's function it runs is exported by
the app (a new entry in its `exports`, in review).

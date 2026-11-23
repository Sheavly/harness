# sheavly

The sheavly command line: the one command of the whole product, which runs the server and the
terminal. It holds the command line and nothing else: the server is the backend's `runServer`
and the chat the terminal's `runTerminalChat`, started in this process. It is the one workspace
the layout lets depend on apps (`sheavly.launcher`), and nothing depends on it.

```bash
npm run sheavly -- --version        # from the checkout, from source
npm run sheavly -- --help           # lists the commands that exist
npm run sheavly -- serve            # the server in the foreground, as `npm run serve`
npm run sheavly -- chat             # the terminal chat, on the server `serve` runs
npm run sheavly -- doctor           # what is installed, what runs and what is wrong
node apps/sheavly/dist/cli.js chat  # after `npm run build`
```

`chat` finds your running server through the discovery file, proves it with its handshake before
it sends the token, and never starts one: run `sheavly serve` in another terminal first, or name a
server with `BACKEND_URL` and `BACKEND_TOKEN` ([design](docs/design.md#the-commands)).

| Command           | What it does                                                                     |
| ----------------- | -------------------------------------------------------------------------------- |
| `--version`       | Prints the version of this package                                               |
| `--help`          | Lists the commands; `sheavly <command> --help` says what one takes               |
| `serve [options]` | Runs the backend in the foreground with the environment's settings and `--trust` |
| `chat [options]`  | Opens the terminal chat on your running server, or the one `BACKEND_URL` names   |
| `doctor`          | Reports Node, the home, the server and the profile; exits 1 when one is wrong    |

An unknown command or a missing one exits 2 with a message that points to `--help`; `--help` or
`-h` anywhere after a command shows its help and runs nothing (quote a first message that holds
one). A command that fails exits 1 with one line, and so does `serve` with an argument the
server doesn't read (it takes `--trust` only), before anything starts. `SHEAVLY_DEBUG=1` prints
the stack instead. Its modules are
`dispatch/` (the table of commands, the help and the exit codes), `serve/`, `chat/`, `doctor/` and
`version/`, and `cli.ts`, the entry that wires them to the process. It exports nothing.

## Docs

- [Design](docs/design.md): how it works, and how to extend it.

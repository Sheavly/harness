# sheavly

The sheavly command line: the one command of the whole product, which runs the server and the
terminal. It holds the command line and nothing else: the server is the backend's `runServer`
and the chat the terminal's `runTerminalChat`, started in this process. It is the one workspace
the layout lets depend on apps (`sheavly.launcher`), and nothing depends on it.

```bash
npm run sheavly -- --version        # from the checkout, from source
npm run sheavly -- --help           # lists the commands that exist
npm run sheavly -- serve            # the server in the foreground, as `npm run serve`
npm run sheavly -- chat             # the terminal chat, as `npm run dev:terminal`
node apps/sheavly/dist/cli.js serve # after `npm run build`
```

`node apps/sheavly/dist/cli.js chat` needs `BACKEND_URL` and `BACKEND_TOKEN`: a chat starts its
own backend through npm, from the checkout, so without them run it as `npm run sheavly -- chat`
([design](docs/design.md#the-commands)).

| Command           | What it does                                                                       |
| ----------------- | ---------------------------------------------------------------------------------- |
| `--version`       | Prints the version of this package                                                 |
| `--help`          | Lists the commands; `sheavly <command> --help` says what one takes                 |
| `serve [options]` | Runs the backend in the foreground with the environment's settings and `--trust`   |
| `chat [options]`  | Opens the terminal chat; it starts its own backend, or uses `BACKEND_URL`/`_TOKEN` |

An unknown command or a missing one exits 2 with a message that points to `--help`; `--help` or
`-h` anywhere after a command shows its help and runs nothing (quote a first message that holds
one). A command that fails exits 1 with one line, and so does `serve` with an argument the
server doesn't read (it takes `--trust` only), before anything starts. `SHEAVLY_DEBUG=1` prints
the stack instead. Its modules are
`dispatch/` (the table of commands, the help and the exit codes), `serve/`, `chat/` and
`version/`, and `cli.ts`, the entry that wires them to the process. It exports nothing.

## Docs

- [Design](docs/design.md): how it works, and how to extend it.

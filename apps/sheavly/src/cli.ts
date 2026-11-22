#!/usr/bin/env node
/**
 * The `sheavly` command line: the entry of the product's one command.
 *
 *   npm run sheavly -- <command>       from the checkout, from source
 *   node apps/sheavly/dist/cli.js      after `npm run build`
 *
 * `sheavly --version`, `sheavly --help`, `sheavly serve` and `sheavly chat`: see
 * apps/sheavly/docs/design.md. An uncaught error is one line and a non-zero exit code; the stack
 * only with SHEAVLY_DEBUG set. This file wires the commands to the process; the table, the help
 * and the exit codes are `dispatch`.
 */
import { runServer } from '@sheavly/backend/run-server/run-server.helper';
import { reportChatFailure } from '@sheavly/terminal/chat/chat-failure.helper';
import { runTerminalChat } from '@sheavly/terminal/chat/start.helper';
import { createChatCommand } from './chat/chat.helper.js';
import { dispatch } from './dispatch/dispatch.helper.js';
import { createServeCommand } from './serve/serve.helper.js';
import { readCliVersion } from './version/version.helper.js';

// npm runs a script inside its workspace's folder; work from the folder it was started in (npm's
// INIT_CWD), so the default workspace is the user's.
if (process.env.INIT_CWD) process.chdir(process.env.INIT_CWD);

const code = await dispatch({
  argv: process.argv.slice(2),
  env: process.env,
  commands: [
    createChatCommand({ runChat: runTerminalChat, reportFailure: reportChatFailure }),
    createServeCommand({ runServer }),
  ],
  streams: {
    out: (text) => void process.stdout.write(text),
    err: (text) => void process.stderr.write(text),
  },
  readVersion: () => readCliVersion(),
});

// Not `process.exit`: a server that listens keeps the process alive, and a chat that failed has
// already set its own exit code.
if (code !== 0) process.exitCode = code;

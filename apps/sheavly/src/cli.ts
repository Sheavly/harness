#!/usr/bin/env node
/**
 * The `sheavly` command line: the entry of the product's one command.
 *
 *   npm run sheavly -- <command>       from the checkout, from source
 *   node apps/sheavly/dist/cli.js      after `npm run build`
 *
 * `sheavly --version`, `sheavly --help`, `sheavly serve`, `sheavly service`, `sheavly chat`,
 * `sheavly connection`, `sheavly setup` and `sheavly doctor`: see apps/sheavly/docs/design.md. An
 * uncaught error is one line and a non-zero exit code; the stack only with SHEAVLY_DEBUG set. This
 * file wires the commands to the process; the table, the help and the exit codes are `dispatch`.
 */
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { runServer } from '@sheavly/backend/run-server/run-server.helper';
import { reportChatFailure } from '@sheavly/terminal/chat/chat-failure.helper';
import { runTerminalChat } from '@sheavly/terminal/chat/start.helper';
import { runTerminalSetup } from '@sheavly/terminal/setup/run-setup.helper';
import { createChatCommand } from './chat/chat.helper.js';
import { findChatServer, findVerifiedServer } from './chat/find-server.helper.js';
import { createConnectionCommand } from './connection/connection.helper.js';
import { dispatch } from './dispatch/dispatch.helper.js';
import { createDoctorCommand } from './doctor/doctor.helper.js';
import { createServeCommand } from './serve/serve.helper.js';
import { askYesNo } from './service/ask.helper.js';
import { createServiceCommand } from './service/service.helper.js';
import { createSystemTools } from './service/system.helper.js';
import { createSetupCommand } from './setup/setup.helper.js';
import { readCliVersion } from './version/version.helper.js';

// npm runs a script inside its workspace's folder; work from the folder it was started in (npm's
// INIT_CWD), so the default workspace is the user's.
if (process.env.INIT_CWD) process.chdir(process.env.INIT_CWD);

const streams = {
  out: (text: string) => void process.stdout.write(text),
  err: (text: string) => void process.stderr.write(text),
};

const code = await dispatch({
  argv: process.argv.slice(2),
  env: process.env,
  commands: [
    createChatCommand({
      runChat: runTerminalChat,
      findServer: findChatServer,
      reportFailure: reportChatFailure,
    }),
    createConnectionCommand({
      findServer: findVerifiedServer,
      streams,
      // `isTTY` is undefined, not false, when stdout is a pipe or a file: falsy either way.
      outputIsTerminal: process.stdout.isTTY,
    }),
    createDoctorCommand({
      nodeVersion: process.versions.node,
      uid: process.getuid?.() ?? 0,
      platform: process.platform,
      streams,
    }),
    createServeCommand({ runServer }),
    createServiceCommand({
      platform: process.platform,
      nodePath: process.execPath,
      cliPath: fileURLToPath(import.meta.url),
      homeDir: os.homedir(),
      uid: process.getuid?.() ?? 0,
      system: createSystemTools(),
      interactive: process.stdin.isTTY && process.stdout.isTTY,
      confirm: askYesNo,
      streams,
    }),
    createSetupCommand({
      runSetup: runTerminalSetup,
      findServer: findChatServer,
      reportFailure: reportChatFailure,
      streams,
    }),
  ],
  streams,
  readVersion: () => readCliVersion(),
});

// Not `process.exit`: a server that listens keeps the process alive, and a chat that failed has
// already set its own exit code.
if (code !== 0) process.exitCode = code;

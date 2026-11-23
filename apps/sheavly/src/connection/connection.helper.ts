import type { VerifiedServer } from '../chat/chat.types.js';
import type { CliCommand, Streams } from '../command/command.types.js';
import { ConnectionError, UsageError } from '../errors/cli.errors.js';
import {
  CONNECTION_HELP,
  CONNECTION_NAME,
  CONNECTION_SUMMARY,
  JSON_FLAG,
  TERMINAL_REFUSAL,
} from './connection.constants.js';
import type { Connection } from './connection.types.js';
import { environmentConnection, renderConnection } from './connection.utils.js';

/** Fails unless the arguments are `--json`, once, and nothing else: what is printed is a secret. */
function requireJsonFlag(args: readonly string[]): void {
  // Anything but the flag in first place, and anything at all after it. The message does not
  // repeat the argument: someone who typed the token here would see it written to stderr.
  const unexpected = args.some((arg, index) => arg !== JSON_FLAG || index > 0);

  if (unexpected) {
    throw new UsageError(
      `"sheavly connection" takes ${JSON_FLAG} once and nothing else. Run "sheavly connection --help".`,
    );
  }

  if (args.length === 0) {
    throw new UsageError(
      `"sheavly connection" needs ${JSON_FLAG}: it prints the server's token, so the command says so. Run "sheavly connection --help".`,
    );
  }
}

/**
 * The `connection` command: prints the connection of the user's running server as one line of
 * JSON, for a front end that must reach it without reading the home folder. With `BACKEND_URL`
 * and `BACKEND_TOKEN` set it prints those and contacts nothing (`environmentConnection`); else it
 * prints what `findServer` found and verified (`source: discovery`), or throws what it throws
 * when there is none (a `NoServerError`, saying why, never holding the token) with nothing
 * printed. The token goes to `streams.out` only, and only in that one line. It never starts a
 * server, and takes `--json` and nothing else. It refuses, before it looks for anything, when
 * `outputIsTerminal`: a token written to a terminal stays in its scrollback, and a program that
 * reads the line reads a pipe.
 */
export function createConnectionCommand(params: {
  findServer: (env: NodeJS.ProcessEnv) => Promise<VerifiedServer>;
  streams: Streams;
  outputIsTerminal: boolean;
}): CliCommand {
  const { findServer, streams, outputIsTerminal } = params;

  return {
    name: CONNECTION_NAME,
    summary: CONNECTION_SUMMARY,
    help: CONNECTION_HELP,
    run: async ({ args, env }) => {
      requireJsonFlag(args);

      if (outputIsTerminal) throw new ConnectionError(TERMINAL_REFUSAL);

      const given = environmentConnection(env);
      const connection: Connection = given
        ? { source: 'environment', ...given }
        : { source: 'discovery', ...(await findServer(env)) };

      streams.out(renderConnection(connection));
    },
  };
}

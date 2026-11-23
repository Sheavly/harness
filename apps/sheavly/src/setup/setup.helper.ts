import type { ChatServer } from '../chat/chat.types.js';
import type { CliCommand, Streams } from '../command/command.types.js';
import { UsageError } from '../errors/cli.errors.js';
import { SETUP_DONE, SETUP_HELP, SETUP_NAME, SETUP_SUMMARY } from './setup.constants.js';
import type { RunSetup } from './setup.types.js';

/**
 * The `setup` command: runs the terminal's setup wizard (`runSetup`) on the running server
 * `findServer` finds, then says what to run next. `BACKEND_URL` is not used, unlike `chat`: setup
 * sends a provider key, and that goes only to a server the finder verified with its handshake. It
 * never starts a server, takes no argument, and with none found, or no terminal to ask in, the
 * failure goes to `reportFailure`, which ends the process with the exit code (1; 130 when the user
 * cancelled). The key never passes through here: the wizard sends it to the server's credential
 * route.
 */
export function createSetupCommand(params: {
  runSetup: RunSetup;
  findServer: (env: NodeJS.ProcessEnv) => Promise<ChatServer>;
  reportFailure: (caughtError: unknown) => void;
  streams: Streams;
}): CliCommand {
  const { runSetup, findServer, reportFailure, streams } = params;

  return {
    name: SETUP_NAME,
    summary: SETUP_SUMMARY,
    help: SETUP_HELP,
    run: async ({ args, env }) => {
      const [unexpected] = args;

      if (unexpected !== undefined) {
        throw new UsageError(
          `"sheavly setup" takes no arguments, got "${unexpected}". Run "sheavly setup --help".`,
        );
      }

      try {
        await runSetup({ env, server: await findServer(env) });
        streams.out(SETUP_DONE);
      } catch (caughtError) {
        reportFailure(caughtError);
      }
    },
  };
}

import type { ChatServer } from '../chat/chat.types.js';
import type { CliCommand, Streams } from '../command/command.types.js';
import { UsageError } from '../errors/cli.errors.js';
import { runThenClose, serverForSetup } from './server-for-setup.helper.js';
import {
  SETUP_DONE,
  SETUP_DONE_PRIVATE,
  SETUP_HELP,
  SETUP_NAME,
  SETUP_SUMMARY,
} from './setup.constants.js';
import type { RunSetup, StartPrivateServer } from './setup.types.js';

/**
 * The `setup` command: runs the terminal's setup wizard (`runSetup`) on the running server
 * `findServer` finds, then says what to run next. With none running at all, and a terminal to ask
 * in (`interactive`), it starts a short-lived server of its own with `startServer`, runs the
 * wizard on that, and stops it however the wizard ends: saved, cancelled or failed
 * (`serverForSetup`). It is the one command that starts a server, and it holds none after it
 * ends. `BACKEND_URL` is not used, unlike `chat`: setup sends a provider key, and that goes only
 * to a server the finder verified with its handshake, one it started included. It takes no
 * argument, and a failure (no server it may start, no terminal, a refused or cancelled setup)
 * goes to `reportFailure`, which ends the process with the exit code (1; 130 when the user
 * cancelled). The key never passes through here: the wizard sends it to the server's credential
 * route.
 */
export function createSetupCommand(params: {
  runSetup: RunSetup;
  findServer: (env: NodeJS.ProcessEnv) => Promise<ChatServer>;
  startServer: StartPrivateServer;
  interactive: boolean;
  reportFailure: (caughtError: unknown) => void;
  streams: Streams;
}): CliCommand {
  const { runSetup, findServer, startServer, interactive, reportFailure, streams } = params;

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
        const { server, close } = await serverForSetup({
          env,
          findServer,
          startServer,
          interactive,
        });

        // Whatever the wizard does, a server this started does not outlive it; the line that says
        // it is saved comes after the server is down, so a failure to stop is never printed after it.
        await runThenClose({ run: () => runSetup({ env, server }), ...(close && { close }) });
        streams.out(close ? SETUP_DONE_PRIVATE : SETUP_DONE);
      } catch (caughtError) {
        reportFailure(caughtError);
      }
    },
  };
}

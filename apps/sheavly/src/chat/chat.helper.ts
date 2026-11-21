import type { CliCommand, CommandRun } from '../command/command.types.js';
import { CHAT_HELP, CHAT_NAME, CHAT_SUMMARY } from './chat.constants.js';

/**
 * The `chat` command: runs the terminal's `runTerminalChat` in this process with the environment
 * and the arguments after `chat`, as `npm run dev:terminal` does. A chat that cannot run is
 * handed to `reportFailure`, which says how it ends the process (the terminal's own exit codes).
 */
export function createChatCommand(params: {
  runChat: CommandRun;
  reportFailure: (caughtError: unknown) => void;
}): CliCommand {
  const { runChat, reportFailure } = params;

  return {
    name: CHAT_NAME,
    summary: CHAT_SUMMARY,
    help: CHAT_HELP,
    run: async ({ args, env }) => {
      try {
        await runChat({ args, env });
      } catch (caughtError) {
        reportFailure(caughtError);
      }
    },
  };
}

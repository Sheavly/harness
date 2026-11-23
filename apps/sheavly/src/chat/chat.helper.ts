import type { CliCommand } from '../command/command.types.js';
import { CHAT_HELP, CHAT_NAME, CHAT_SUMMARY } from './chat.constants.js';
import type { ChatServer, RunChat } from './chat.types.js';

/**
 * The `chat` command: runs the terminal's `runTerminalChat` in this process, with the environment
 * and the arguments after `chat`, on the running server `findServer` finds. With `BACKEND_URL`
 * set the file is not read and the terminal connects to that server, as `npm run dev:terminal`
 * does. It never starts a server. A chat that cannot run, no server found included, is handed to
 * `reportFailure`, which says how it ends the process (the terminal's own exit codes).
 */
export function createChatCommand(params: {
  runChat: RunChat;
  findServer: (env: NodeJS.ProcessEnv) => Promise<ChatServer>;
  reportFailure: (caughtError: unknown) => void;
}): CliCommand {
  const { runChat, findServer, reportFailure } = params;

  return {
    name: CHAT_NAME,
    summary: CHAT_SUMMARY,
    help: CHAT_HELP,
    run: async ({ args, env }) => {
      try {
        const server = env.BACKEND_URL ? undefined : await findServer(env);

        await runChat({ args, env, ...(server && { server }) });
      } catch (caughtError) {
        reportFailure(caughtError);
      }
    },
  };
}

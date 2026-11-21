import type { CliCommand, CommandRun } from '../command/command.types.js';
import { SERVE_HELP, SERVE_NAME, SERVE_SUMMARY } from './serve.constants.js';

/**
 * The `serve` command: runs the backend's `runServer` in this process with the environment and the
 * arguments after `serve`, so it behaves as `npm run serve` does. It resolves once the server
 * listens; the server keeps the process alive and ends it on a signal. Which arguments it takes is
 * the server's to say: it refuses one it doesn't read before anything starts.
 */
export function createServeCommand(params: { runServer: CommandRun }): CliCommand {
  const { runServer } = params;

  return {
    name: SERVE_NAME,
    summary: SERVE_SUMMARY,
    help: SERVE_HELP,
    run: ({ args, env }) => runServer({ args, env }),
  };
}

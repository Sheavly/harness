import { guardStartup } from '../discovery/startup-signals.helper.js';
import { parseCliSettings, parseRunEnv, parseServerEnv } from '../harness/settings.validator.js';
import { printStarted } from './print-started.helper.js';
import type { RunServerParams } from './run-server.types.js';
import { startServer } from './start-server.helper.js';
import { stopOnSignals, stopWhenParentGone } from './stop-server.helper.js';

/**
 * Runs the harness backend in this process: reads its settings from `env` and `args` (the
 * process's own by default), takes the lock, listens, publishes the discovery file and prints
 * the `→ listening on <url>` line. It resolves once the server listens and keeps the process
 * alive; a signal or, with SERVER_EXIT_WITH_PARENT, a closed stdin stops it and calls `exit`.
 * Throws a settings or build error before anything is taken, and the listen error after the lock
 * is released. The order of the steps is the contract: a signal at any point must leave nothing
 * behind (`startServer` holds the start, this adds the signals, the output and the exit).
 */
export async function runServer(params: RunServerParams = {}): Promise<void> {
  const {
    env = process.env,
    args = process.argv.slice(2),
    exit = (code) => process.exit(code),
  } = params;

  // npm runs a workspace's script inside its folder; work from the folder it was started in
  // (npm's INIT_CWD), so the default workspace is the user's.
  if (env.INIT_CWD) process.chdir(env.INIT_CWD);

  const settings = { ...parseCliSettings({ env, args }), ...parseRunEnv(env) };
  const server = parseServerEnv(env);
  const log = (text: string) => void process.stderr.write(text);

  // Before the lock and the file exist: a signal while starting must not leave them behind.
  const guard = guardStartup({ source: process, exit, log });
  const started = await startServer({ env, settings, server, log, guard });

  if (started.status === 'refused') {
    log(`${started.message}\n`);

    return exit(1);
  }

  const { built, presence, address } = started;
  const stop = stopOnSignals({ built, presence, exit });

  // After the stop handlers and before the `listening` line: with no listener for a moment, Node
  // restores the default action, and a UI that signals on that line would kill the process.
  guard.uninstall();
  printStarted({
    env,
    server,
    token: built.token,
    address,
    toTerminal: process.stdout.isTTY,
  });

  if (settings.exitWithParent) stopWhenParentGone(stop);
}

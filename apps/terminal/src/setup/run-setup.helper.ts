import path from 'node:path';
import type { FoundBackend } from '../client/client.types.js';
import { attachedTo } from '../client/session.helper.js';
import { prepareSetup } from './setup.helper.js';
import type { SetupUi } from './setup.types.js';

/**
 * Runs the setup wizard (profile, model, key) on `server`, a running backend the caller found and
 * verified, and ends: no conversation is opened. It connects to that one backend only: it never
 * starts or stops one, and it does not read `BACKEND_URL`, because setup sends a provider key and
 * that goes only to a server that proved it holds the token. The wizard binds the workspace
 * (`WORKSPACE_ROOT`, else the current folder) to the profile, as `--setup` does. It asks on the
 * terminal's setup screen, which needs an interactive terminal (a `SetupError` otherwise), unless
 * `ui` answers the questions: a test's seam, never for a caller that has a terminal. Esc or
 * Ctrl+C throws `SetupCancelledError`; `reportChatFailure` gives both their exit codes.
 */
export async function runTerminalSetup(params: {
  env?: NodeJS.ProcessEnv;
  server: FoundBackend;
  ui?: SetupUi;
}): Promise<void> {
  const { env = process.env, server, ui } = params;

  await prepareSetup({
    backend: attachedTo(server),
    workspace: path.resolve(env.WORKSPACE_ROOT ?? process.cwd()),
    interactive: process.stdin.isTTY && process.stdout.isTTY,
    force: true,
    ...(ui && { ui }),
  });
}

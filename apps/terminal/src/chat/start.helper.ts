import path from 'node:path';
import { createClient } from '@sheavly/client/client/client.helper';
import type { FoundBackend } from '../client/client.types.js';
import { profileArgs } from '../client/profile-args.utils.js';
import { closeSession, openSession } from '../client/session.helper.js';
import { SetupError } from '../errors/setup.errors.js';
import { abortingStop, interruptOnCtrlC } from '../interrupt/interrupt.helper.js';
import { prepareSetup } from '../setup/setup.helper.js';
import { startScreenChat } from '../tui/screen-chat.helper.js';
import { runLineChat } from './line-chat.helper.js';

/**
 * Owns startup and shutdown, including setup before a conversation exists. It reads its settings
 * from `env` and `args` (the process's own by default, so a command in the same process passes
 * its own) and works in the current folder: the caller changes it first, as `chat.ts` does for
 * npm. Throws what could not start: a `SetupError`, a `BackendError`; `reportChatFailure` says
 * how those end the process. With `server` (a backend the caller found and verified) it connects
 * to that one, as it does to `BACKEND_URL`, and never starts or stops a backend.
 */
export async function runTerminalChat(
  params: { env?: NodeJS.ProcessEnv; args?: readonly string[]; server?: FoundBackend } = {},
): Promise<void> {
  const { env = process.env, args = process.argv.slice(2), server } = params;
  const write = (text: string) => void process.stdout.write(text);
  const interactive = process.stdin.isTTY && process.stdout.isTTY;
  const workspace = path.resolve(env.WORKSPACE_ROOT ?? process.cwd());
  const session = await openSessionInterruptibly({
    write,
    args,
    env,
    workspace,
    interactive,
    ...(server && { server }),
  });

  if (!session) {
    process.exitCode = 130;

    return;
  }

  const { backend, conversation, details, renderer, prompt: firstPrompt } = session;
  let closing: Promise<void> | undefined;
  const end = () => (closing ??= closeSession({ backend, conversation }));
  const onHangup = () => void end().finally(() => process.exit(129));
  const onTerminate = () => void end().finally(() => process.exit(143));

  process.once('SIGHUP', onHangup);
  process.once('SIGTERM', onTerminate);

  try {
    if (interactive && !env.SHEAVLY_PLAIN) {
      const skills = (await conversation.skills()).map(({ name, description }) => ({
        name,
        description,
      }));
      const { terminal = {} } = await createClient(backend).call('getSetup', {});
      const chat = await startScreenChat({
        conversation,
        details,
        skills,
        firstPrompt,
        reducedMotion: terminal.reducedMotion ?? false,
        bell: terminal.bell ?? false,
      });

      try {
        await chat.finished;
      } finally {
        await chat.stop();
      }
    } else {
      await runLineChat({
        conversation,
        details,
        renderer,
        write,
        firstPrompt,
        forceQuit: end,
      });
    }
  } finally {
    process.off('SIGHUP', onHangup);
    process.off('SIGTERM', onTerminate);
    await end();
  }

  write('→ conversation ended\n');
}

/**
 * Opens the chat's session with Ctrl+C live from the first moment, so a press while the backend
 * starts (or setup runs) stops that start. Undefined when it was interrupted: nothing to clean up,
 * as a backend that was starting has been stopped. The chat's own handlers take over after.
 */
async function openSessionInterruptibly(params: {
  write: (text: string) => void;
  args: readonly string[];
  env: NodeJS.ProcessEnv;
  workspace: string;
  interactive: boolean;
  server?: FoundBackend;
}): Promise<Awaited<ReturnType<typeof openSession>> | undefined> {
  const { write, args, env, workspace, interactive, server } = params;

  // Setup binds a profile and sets the default; a run on a named profile changes neither.
  if (args.includes('--setup') && profileArgs(args).profile) {
    throw new SetupError(
      '--setup cannot be combined with --profile: setup changes which profile is used.',
    );
  }

  const startup = new AbortController();
  const ctrlC = interruptOnCtrlC({
    write,
    stop: abortingStop(startup),
    // Nothing exists yet to clean up: a starting backend is stopped by the abort itself.
    forceQuit: () => Promise.resolve(),
  });

  try {
    return await openSession({
      env,
      args: args.filter((arg) => arg !== '--setup'),
      write,
      workspace,
      signal: startup.signal,
      ...(server && { server }),
      prepare: (backend) =>
        prepareSetup({ backend, workspace, interactive, force: args.includes('--setup') }),
    });
  } catch (caughtError) {
    if (startup.signal.aborted) return undefined;
    throw caughtError;
  } finally {
    ctrlC.dispose();
  }
}

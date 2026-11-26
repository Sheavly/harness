import type { RunOutcome } from '@sheavly/protocol/session/session.types';
import { runEnd } from '@sheavly/protocol/status/run-end.utils';
import { saveRawStream } from '../client/raw-stream.helper.js';
import { closeSession, openSession } from '../client/session.helper.js';
import { abortingStop, interruptOnCtrlC } from '../interrupt/interrupt.helper.js';
import type { CtrlCSource } from '../interrupt/interrupt.types.js';
import { shortId } from '../render/render.utils.js';
import { describeFailure } from '../render/terminal-text.utils.js';
import { DEFAULT_PROMPT } from './demo.prompt.js';

type DemoSession = Awaited<ReturnType<typeof openSession>>;

/**
 * The demo: one prompt on a backend of its own, printed as it happens. Returns the exit code: 0,
 * 1 for a failed or unfinished run, 130 when Ctrl+C stopped it. Ctrl+C is live before the backend
 * starts; the backend and conversation are always ended, the normal way or by a force quit.
 */
export async function runDemo(params: {
  env: NodeJS.ProcessEnv;
  args: readonly string[];
  write: (text: string) => void;
  source?: CtrlCSource;
  exit?: (code: number) => void;
}): Promise<number> {
  const { env, args, write } = params;
  const interrupt = new AbortController();
  let session: DemoSession | undefined;
  let closing: Promise<void> | undefined;
  const end = () => {
    if (!session) return Promise.resolve();

    return (closing ??= closeSession(session));
  };
  const ctrlC = interruptOnCtrlC({
    write,
    stop: abortingStop(interrupt),
    forceQuit: end,
    ...(params.source && { source: params.source }),
    ...(params.exit && { exit: params.exit }),
  });

  try {
    session = await openSession({ env, args, write, signal: interrupt.signal });
  } catch (caughtError) {
    ctrlC.dispose();
    if (interrupt.signal.aborted) return 130;
    throw caughtError;
  }

  try {
    return await runPrompt({ session, env, write, interrupt });
  } finally {
    // Stopping the backend has to happen even when closing the conversation fails.
    await end();
    ctrlC.dispose();
  }
}

/** Sends the prompt and prints its stream; the exit code says how it ended. */
async function runPrompt(params: {
  session: DemoSession;
  env: NodeJS.ProcessEnv;
  write: (text: string) => void;
  interrupt: AbortController;
}): Promise<number> {
  const { session, env, write, interrupt } = params;
  const { conversation, details, renderer } = session;
  const prompt = session.prompt || DEFAULT_PROMPT;

  write(`→ ${prompt}\n\n→ main session ${shortId(details.session)}\n`);

  // What the demo says it stops at its end is what the conversation's tree shows running. Followed
  // before anything else is opened, so a tree the backend refuses leaves nothing running.
  const stopTree = new AbortController();
  const tree = await conversation.watchBackground({
    listener: () => undefined,
    signal: stopTree.signal,
  });
  const treeLost = tree.ended.catch((caughtError: unknown) => {
    write(`\n✗ Lost the background status: ${describeFailure(caughtError)}\n`);
  });

  /** With SESSIONS_SSE_LOG, the conversation's SSE stream (what a UI reads) goes to a file. */
  const sseLog = env.SESSIONS_SSE_LOG;
  const stopSse = new AbortController();
  const sseWritten = sseLog
    ? saveRawStream({
        stream: await conversation.rawStream(stopSse.signal),
        file: sseLog,
        stop: stopSse,
      })
    : Promise.resolve();
  let failure: string | undefined;
  let outcome: RunOutcome | undefined;

  try {
    for await (const entry of conversation.send({ text: prompt, signal: interrupt.signal })) {
      renderer.entry(entry, details.session);
      outcome = runEnd(entry) ?? outcome;
    }
  } catch (caughtError) {
    failure = describeFailure(caughtError);
    write(`\n✗ Run failed: ${failure}\n`);
  }

  // Background tasks outlive a prompt, but not the demo: closing stops whatever is left. The tree
  // is its own connection, so a command the prompt just started may not be counted yet: the line
  // is a courtesy, and closing stops the work either way.
  if (conversation.runningTasks > 0) {
    write(`⏹ Stopping ${String(conversation.runningTasks)} background task(s)\n`);
  }

  stopTree.abort();
  await treeLost;
  stopSse.abort();
  await sseWritten;

  const unfinished = outcome !== undefined && outcome !== 'completed' && outcome !== 'interrupted';

  if (failure || unfinished) return 1;

  return interrupt.signal.aborted ? 130 : 0;
}

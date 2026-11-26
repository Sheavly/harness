import { execFileSync } from 'node:child_process';
import { now } from '@sheavly/core/clock/clock.helper';
import { isMissingPath } from '@sheavly/runtime/errors/errors.utils';
import type { ClientHistoryMessage } from '@sheavly/protocol/history/history.types';
import { runEnd } from '@sheavly/protocol/status/run-end.utils';
import type { StreamEntry } from '@sheavly/protocol/stream/stream.types';
import { connectBackend } from '../client/backend.helper.js';
import type { Backend } from '../client/client.types.js';
import { openConversation } from '../client/conversation.helper.js';
import type { RemoteConversation } from '../client/conversation.service.js';
import { BackendError } from '../errors/backend.errors.js';
import { abortingStop, interruptOnCtrlC } from '../interrupt/interrupt.helper.js';
import { Renderer } from '../render/render.service.js';
import { projectTrustNotice, shortId } from '../render/render.utils.js';
import { describeFailure } from '../render/terminal-text.utils.js';
import { settleBackground } from './background.helper.js';
import { RunRecorder } from './recorder.service.js';
import { runEnv } from './run-env.utils.js';
import type { WorkbookStore } from './store.service.js';
import type { CheckContext, RunId, RunRequest, RunResult } from './workbook.types.js';
import { CheckApprovals } from './check-approvals.service.js';
import { assertCheckBackend, assertCheckWorkspace } from './check-isolation.helper.js';
import { WorkbookCheckError } from './check.errors.js';
import { parseApprovedCommands } from './check-approval.validator.js';
import { runId } from './workbook.utils.js';

/**
 * One workbook run: claims a run folder, prepares the workspace, starts a backend for it alone
 * (on that workspace, with the run's trust, turn limit and model-call file), then streams the run
 * to the terminal while recording everything (`RunRecorder`). Ctrl+C stops it cleanly and still
 * saves the result; a failure is saved as `outcome: failed` with the error.
 */
export async function runWorkbook(params: {
  store: WorkbookStore;
  request: RunRequest;
  /** Where trust is remembered: the user's store by default, a throwaway file for `check`. */
  trustFile?: string;
  checkContext?: CheckContext;
}): Promise<RunResult & { id: RunId }> {
  const { store, request, trustFile } = params;
  const checkContext = params.checkContext && {
    approvedCommands: parseApprovedCommands(params.checkContext.approvedCommands),
  };

  if (checkContext) {
    assertCheckBackend(process.env);

    if (request.continues) {
      throw new WorkbookCheckError({
        message: 'Checks cannot continue an arbitrary saved workspace.',
      });
    }
  }

  const interrupt = new AbortController();
  const live: LiveRun = {};
  // Everything printed goes in the transcript too, once there is a recorder.
  const write = (text: string) => {
    process.stdout.write(text);
    live.recorder?.transcript(text);
  };
  // Installed before the run folder and the backend exist, so a press during startup stops that
  // too. A force quit ends the backend and closes the recorder's files first: nothing buffered is
  // lost, and the run folder stays readable.
  const ctrlC = interruptOnCtrlC({
    write,
    stop: abortingStop(interrupt),
    forceQuit: () => endRun(live),
  });

  try {
    return await startRun({ store, request, trustFile, checkContext, interrupt, live, write });
  } finally {
    try {
      await endRun(live);
    } finally {
      ctrlC.dispose();
    }
  }
}

/** What a run has started so far, for whatever ends it to clean up. */
type LiveRun = { backend?: Backend; recorder?: RunRecorder };

/** Stops the run's backend and closes its recorder, even when the backend fails to stop. */
async function endRun(live: LiveRun): Promise<void> {
  try {
    await live.backend?.stop();
  } finally {
    await live.recorder?.dispose();
  }
}

/** Claims the run folder and workspace, starts the backend and streams the run on it. */
async function startRun(params: {
  store: WorkbookStore;
  request: RunRequest;
  trustFile: string | undefined;
  checkContext: CheckContext | undefined;
  interrupt: AbortController;
  live: LiveRun;
  write: (text: string) => void;
}): Promise<RunResult & { id: RunId }> {
  const { store, request, trustFile, checkContext, interrupt, live, write } = params;
  const paths = await store.beginRun({
    id: (number) => runId({ number, prompt: request.name }),
  });
  const { history, workspace: previousWorkspace } = await startingPoint({ store, request });
  const workspace = previousWorkspace
    ? { dir: previousWorkspace, fresh: false }
    : await store.workspace({ prompt: request.stored, key: request.name, keep: request.keep });
  // The recorder is created first so everything the backend prints goes in the transcript.
  const recorder = new RunRecorder(paths);

  live.recorder = recorder;

  try {
    const backend = await connectBackend({
      env: runEnv({
        env: process.env,
        request,
        workspaceRoot: workspace.dir,
        modelCalls: paths.modelCalls,
        trustFile,
      }),
      // Fresh committed fixture copies are trusted; kept workspaces require explicit trust.
      args: workspace.fresh || request.trust ? ['--trust'] : [],
      onOutput: write,
      signal: interrupt.signal,
    });

    live.backend = backend;

    return await streamRun({
      store,
      request,
      history,
      paths,
      recorder,
      write,
      backend,
      checkContext,
      workspaceRoot: workspace.dir,
      interrupt: interrupt.signal,
    });
  } catch (caughtError) {
    // Interrupted while the backend started: the run is saved as interrupted, not as a crash.
    if (!interrupt.signal.aborted || live.backend) throw caughtError;

    const result = await recorder.finish({
      outcome: 'interrupted',
      error: describeFailure(caughtError),
      messages: [],
      sessions: 0,
    });

    await store.finishRun({ id: paths.id, prompt: request.name });

    return { ...result, id: paths.id };
  }
}

/** Runs the prompt on the backend's new conversation, recording it, and saves the result. */
async function streamRun(params: {
  store: WorkbookStore;
  request: RunRequest;
  history: ClientHistoryMessage[];
  paths: Awaited<ReturnType<WorkbookStore['beginRun']>>;
  recorder: RunRecorder;
  write: (text: string) => void;
  backend: Backend;
  checkContext: CheckContext | undefined;
  workspaceRoot: string;
  /** Aborted by the first Ctrl+C: the run stops cleanly and its result is still saved. */
  interrupt: AbortSignal;
}): Promise<RunResult & { id: RunId }> {
  const { backend, history } = params;
  const conversation = await openConversation({
    backend,
    messages: history,
    model: params.request.model,
    effort: params.request.effort,
  });
  const stopStream = new AbortController();

  try {
    return await recordConversation({ ...params, conversation, stopStream });
  } finally {
    stopStream.abort();
    await conversation.close();
  }
}

async function recordConversation(
  params: Parameters<typeof streamRun>[0] & {
    conversation: RemoteConversation;
    stopStream: AbortController;
  },
): Promise<RunResult & { id: RunId }> {
  const { request, history, paths, recorder, write, conversation, stopStream, checkContext } =
    params;
  const details = await conversation.details();
  const verifyWorkspace = () =>
    assertCheckWorkspace({
      store: params.store,
      name: request.name,
      workspaceRoot: params.workspaceRoot,
      actualWorkspace: details.workspace,
    });

  if (checkContext) await verifyWorkspace();

  const renderer = new Renderer(write);

  recorder.recordSessions(await conversation.rawStream(stopStream.signal), stopStream);
  await recorder.start({
    id: paths.id,
    prompt: request.name,
    text: request.text,
    ...(request.continues !== undefined && { continues: request.continues }),
    startedAt: now(),
    adapter: details.model.adapter,
    model: details.model.model,
    workspace: details.workspace,
    mainSession: details.session,
    ...(checkContext && {
      approvedCommands: [...checkContext.approvedCommands],
      approvalScope: 'conversation-session' as const,
    }),
    ...gitCommit(),
  });

  write(`→ run ${paths.id} · ${details.model.adapter} / ${details.model.model}\n`);
  write(`→ workspace ${details.workspace}\n`);
  if (request.continues) write(`→ continues ${request.continues} (${history.length} messages)\n`);

  // Written to the transcript too, so a saved run shows its hooks were skipped and why.
  const trustNotice = projectTrustNotice(details.projectTrust);

  if (trustNotice) write(`${trustNotice}\n`);
  write(`→ main session ${shortId(details.session)}\n→ ${request.text}\n\n`);

  const interrupt = { signal: params.interrupt };
  const sessions = new Set([details.session]);
  let outcome: RunResult['outcome'] = 'failed';
  let error: string | undefined;

  try {
    // The prompt's stream and the live feed both carry some entries, so each is shown once by seq.
    // A set, not the highest seq seen: the two streams are not ordered against each other, so an
    // earlier entry can arrive after a later one and must still be shown.
    const shown = new Set<number>();
    const show = (entry: StreamEntry) => {
      if (shown.has(entry.seq)) return;

      shown.add(entry.seq);
      sessions.add(entry.sessionId);
      if (entry.kind === 'event') recorder.event(entry.event);
      renderer.entry(entry, details.session);
      outcome = runEnd(entry) ?? outcome;
    };
    const send = async (signal: AbortSignal) => {
      const combined = AbortSignal.any([signal, interrupt.signal]);

      combined.throwIfAborted();

      // A watcher failure races the prompt to close the conversation; its late events, from the
      // prompt or the live feed, must not overwrite the saved failure or write to a closed recorder.
      const accept = (entry: StreamEntry) => {
        if (signal.aborted && !interrupt.signal.aborted) return;

        show(entry);
      };
      // The backend ends the prompt when the model does, then starts a run of its own to deliver
      // what its background work produced; only the live feed carries that run.
      const stopFollowing = new AbortController();
      const feedFailed = new AbortController();
      // A follower's failure is kept and read below, and it also stops the wait for background
      // work: without the feed or the tree that work's counts no longer move, so waiting on them
      // would only run out.
      const failureOf = (ended: Promise<void>) =>
        ended.then(
          () => undefined,
          (caughtError: unknown) => {
            feedFailed.abort();

            return caughtError;
          },
        );
      const failures: Promise<unknown>[] = [];

      try {
        // The counts `settleBackground` waits on come from the conversation's tree, followed as
        // long as the live feed is. Both are opened inside this `try`, so one that fails to open
        // leaves the other stopped.
        const tree = await conversation.watchBackground({
          listener: () => undefined,
          signal: stopFollowing.signal,
        });

        failures.push(failureOf(tree.ended));

        const live = await conversation.follow({ onEntry: accept, signal: stopFollowing.signal });

        failures.push(failureOf(live.ended));

        // Skills mentioned by the prompt run with it, as in the chat.
        for await (const entry of conversation.send({ text: request.text, signal: combined })) {
          if (signal.aborted && !interrupt.signal.aborted) break;

          accept(entry);
        }

        await settleBackground({
          conversation,
          signal: AbortSignal.any([combined, feedFailed.signal]),
        });
        // Interrupted while waiting: the run is saved as interrupted, not as a completed one.
        interrupt.signal.throwIfAborted();
      } finally {
        stopFollowing.abort();
      }

      const failure = (await Promise.all(failures)).find((each) => each !== undefined);

      if (failure instanceof Error) throw failure;

      if (failure !== undefined) {
        throw new BackendError({ message: 'The live stream failed', cause: failure });
      }
    };

    if (checkContext) {
      const approvals = new CheckApprovals({
        conversation,
        approvedCommands: checkContext.approvedCommands,
        verifyWorkspace,
      });

      await approvals.run({ operation: send, signal: interrupt.signal });
    } else {
      await send(interrupt.signal);
    }
  } catch (caughtError) {
    outcome = interrupt.signal.aborted ? 'interrupted' : 'failed';
    error = caughtError instanceof Error ? caughtError.message : String(caughtError);
    write(`\n✗ Run failed: ${describeFailure(caughtError)}\n`);
  }

  // Before `finish`, which closes the transcript: the saved run says where it is.
  write(`\n→ saved to ${paths.dir}\n`);

  const result = await recorder.finish({
    outcome,
    error,
    messages: await conversation.messages(),
    sessions: sessions.size,
  });

  await params.store.finishRun({ id: paths.id, prompt: request.name });

  return { ...result, id: paths.id };
}

/** A follow-up starts from that run's conversation, in that run's workspace. */
async function startingPoint(params: {
  store: WorkbookStore;
  request: RunRequest;
}): Promise<{ history: ClientHistoryMessage[]; workspace?: string }> {
  const { store, request } = params;

  if (!request.continues) return { history: [] };

  const [history, meta] = await Promise.all([
    store.messages(request.continues),
    store.meta(request.continues),
  ]);

  // A notice is written by the harness alone: a backend refuses one in a starting history.
  return {
    history: history.filter((entry) => entry.role !== 'notice'),
    workspace: meta.workspace,
  };
}

/** The commit the harness was at, so a run can be tied to the code that produced it. */
function gitCommit(): { gitCommit?: string } {
  try {
    const commit = execFileSync('git', ['rev-parse', '--short', 'HEAD'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
    const dirty = execFileSync('git', ['status', '--porcelain'], { encoding: 'utf8' }).trim();

    return { gitCommit: dirty ? `${commit}+uncommitted` : commit };
  } catch (caughtError) {
    // Not a git checkout (git exits non-zero) or no git installed (ENOENT): the run simply has
    // no commit to record. Anything else is a real failure and surfaces.
    const status = (caughtError as { status?: unknown }).status;

    if (typeof status === 'number' || isMissingPath(caughtError)) return {};
    throw caughtError;
  }
}

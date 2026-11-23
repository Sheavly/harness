import type {
  RunChildParams,
  RunChildResult,
} from '@sheavly/extension/run-services/run-services.types';
import type { SessionRef } from '@sheavly/protocol/session/session.types';
import type { SessionRegistry } from '@sheavly/runtime/sessions/sessions.service';
import type { TaskRegistry } from '@sheavly/runtime/tasks/tasks.service';
import type { RunLoop } from './run-services.types.js';

/**
 * Runs the loop for `child`, a session the scope started, with the run's full registries, which
 * the extension never holds. The history is kept before the run (a crash mid-run does not lose
 * what the agent was asked), by the loop after each turn, and with the whole of it when the run
 * returns. The child's tasks are stopped however the run ends: its parent's and siblings' share
 * the registry and stay.
 */
export async function runChildLoop(params: {
  runLoop: RunLoop;
  registry: SessionRegistry;
  tasks: TaskRegistry;
  child: SessionRef;
  run: Omit<RunChildParams, 'child'>;
}): Promise<RunChildResult> {
  const { runLoop, registry, tasks, child, run } = params;
  const { provider, tools, hooks, instructions, messages, signal, summary, keepHistory, onRunEnd } =
    run;

  keepHistory?.(messages);

  let result: RunChildResult;

  try {
    result = await runLoop({
      provider,
      tools,
      hooks,
      instructions,
      messages,
      signal,
      tasks,
      session: { registry, ref: child },
      ...(summary && { summary }),
      ...(keepHistory && { keepHistory }),
    });

    keepHistory?.(result.messages);
  } catch (caughtError) {
    endChildAfterFailure({ registry, child });

    return await endRunAfterFailure({ tasks, child, onRunEnd, failure: caughtError });
  }

  await endRun({ tasks, child, onRunEnd });

  return result;
}

/**
 * Ends the child as failed when the loop threw before it ended the session itself (it does so in
 * its own `finally`, so a loop that got that far left it ended). A child left running would hold
 * its node, and a slot of the conversation's bound, for good.
 */
function endChildAfterFailure(params: { registry: SessionRegistry; child: SessionRef }): void {
  const { registry, child } = params;

  if (registry.get(child.id)?.state === 'running') registry.end({ id: child.id, state: 'failed' });
}

/**
 * Ends a run that failed and throws `failure`, always: the run's own error is the one to report,
 * so a failure while ending it (already cancelled what it could) must not replace it.
 */
async function endRunAfterFailure(params: {
  tasks: TaskRegistry;
  child: SessionRef;
  onRunEnd: RunChildParams['onRunEnd'];
  failure: unknown;
}): Promise<never> {
  await Promise.allSettled([endRun(params)]);

  throw params.failure;
}

/**
 * Tells the caller the run ended, then stops the child's tasks. The tasks are stopped even when
 * `onRunEnd` throws, and its error is then thrown.
 */
async function endRun(params: {
  tasks: TaskRegistry;
  child: SessionRef;
  onRunEnd: RunChildParams['onRunEnd'];
}): Promise<void> {
  try {
    // Before the cancel, so the caller stops hearing the child first, as the tool did.
    params.onRunEnd?.();
  } finally {
    await params.tasks.cancelSession(params.child.id);
  }
}

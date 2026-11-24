import type { OutputWriter } from '@sheavly/core/output/output.types';
import type { CallId } from '@sheavly/protocol/message/message.types';
import type { SessionId } from '@sheavly/protocol/session/session.types';
import type { TaskRegistry } from '../tasks/tasks.service.js';
import type { StartTask } from '../tasks/tasks.types.js';

/**
 * Test-only: starts a task that runs until `finish` is called with its exit code, or until it is
 * aborted, which ends it with no exit code as a stopped command does. It is owned by `sessionId`,
 * and is a command unless `backgroundKind` says otherwise.
 */
export function startControlledTask(params: {
  tasks: TaskRegistry;
  sessionId?: SessionId | undefined;
  callId?: CallId | undefined;
  backgroundKind?: StartTask['backgroundKind'];
  command?: string;
  description?: string;
  capture?: OutputWriter | undefined;
}) {
  const { tasks, sessionId, callId, backgroundKind, capture } = params;
  let finish: (exitCode: number | null) => void = () => undefined;
  const task = tasks.start({
    command: params.command ?? 'work',
    description: params.description ?? 'work',
    ...(sessionId && { sessionId }),
    ...(callId && { callId }),
    ...(backgroundKind && { backgroundKind }),
    ...(capture && { capture }),
    run: ({ signal }) =>
      new Promise((resolve) => {
        finish = (exitCode) => resolve({ exitCode });
        signal.addEventListener('abort', () => resolve({ exitCode: null }), { once: true });
      }),
  });

  return { task, finish: (exitCode: number | null) => finish(exitCode) };
}

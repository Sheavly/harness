import type { CallId } from '@sheavly/protocol/message/message.types';
import type { SessionId } from '@sheavly/protocol/session/session.types';
import type { TaskRegistry } from '../tasks/tasks.service.js';
import type { StartTask } from '../tasks/tasks.types.js';

/**
 * Test-only: starts a task that runs until it is aborted, owned by `sessionId` or by nobody, and
 * ends with no exit code as a stopped command does.
 */
export function startHeldTask(params: {
  tasks: TaskRegistry;
  sessionId?: SessionId;
  callId?: CallId;
  /** For a sub-agent's work: the session it runs, as `start_agent` records it. */
  agentSessionId?: SessionId;
  backgroundKind?: StartTask['backgroundKind'];
}) {
  const { tasks, sessionId, callId, agentSessionId, backgroundKind } = params;

  return tasks.start({
    command: 'held',
    description: 'Held until aborted',
    ...(sessionId && { sessionId }),
    ...(callId && { callId }),
    ...(agentSessionId && { agentSessionId }),
    ...(backgroundKind && { backgroundKind }),
    run: ({ signal }) =>
      new Promise((resolve) => {
        signal.addEventListener('abort', () => resolve({ exitCode: null }), { once: true });
      }),
  });
}

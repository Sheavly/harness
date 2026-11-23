import type {
  SessionId,
  SessionInfo,
  SessionUpdate,
} from '@sheavly/protocol/session/session.types';
import { isMainSession } from '@sheavly/protocol/session/session.utils';
import type { ReleasedSessions } from './released-sessions.service.js';
import type { SessionNodes } from './session-nodes.service.js';
import { isOpen } from './sessions.utils.js';

/**
 * Puts back the sessions a stored conversation had, as their last update left them. One that was
 * open when the process ended did not finish: a sub-agent is closed as `lost` for good (it reads as
 * `interrupted`, the nearest state a session has), and the main session goes idle, so the
 * conversation can take its next prompt. Each change is passed to `emit`, so it is in the stream
 * and in the store.
 */
export function restoreSessions(params: {
  stored: readonly SessionInfo[];
  /** The sessions released before the process ended: recorded as released, not made live. */
  released: { into: ReleasedSessions; sessions: readonly SessionInfo[] };
  sessions: SessionNodes;
  emit: (update: SessionUpdate) => void;
}): void {
  const { stored, sessions, emit } = params;
  const changed: { id: SessionId; update: 'session_idle' | 'session_ended' }[] = [];

  for (const session of params.released.sessions) params.released.into.record(session);

  // The stored order is the order sessions started, so a parent comes back before its children.
  // A child whose parent is missing is a corrupt log and fails loudly (`unknown_session`).
  for (const session of stored) {
    if (isMainSession(session)) {
      const idle = idleRestoredMain(session);

      sessions.restore(idle.session);
      if (idle.changed) changed.push({ id: session.id, update: 'session_idle' });
    } else if (isOpen(session.state)) {
      sessions.restore({ ...session, state: 'running' });
      sessions.lose(session.id);
      changed.push({ id: session.id, update: 'session_ended' });
    } else {
      sessions.restore(session);
    }
  }

  for (const { id, update } of changed) {
    const session = sessions.get(id);

    if (session) emit({ type: update, session });
  }
}

/**
 * A restored main session takes the next prompt: idle, whether it was closed or cut off. A run
 * that was still going did not finish; one that ended keeps how it did.
 */
function idleRestoredMain(session: SessionInfo): { session: SessionInfo; changed: boolean } {
  if (session.state === 'idle') return { session, changed: false };

  const { endedAt: _ended, ...open } = session;

  return {
    session: {
      ...open,
      state: 'idle',
      ...(session.state === 'running' && { lastOutcome: 'interrupted' as const }),
    },
    changed: true,
  };
}

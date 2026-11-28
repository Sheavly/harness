import { SessionError } from '../errors/sessions.errors.js';
import { isOpen } from './sessions.utils.js';
import type { InboxMessage, SessionInfo } from '@sheavly/protocol/session/session.types';

/**
 * Throws a `session_ended` `SessionError` unless `session` is still open. `consequence` finishes
 * the message: what an ended session can no longer do ("it can't receive messages").
 */
export function assertOpen(params: { session: SessionInfo; consequence: string }): void {
  const { session, consequence } = params;

  if (isOpen(session.state)) return;

  throw new SessionError({
    reason: 'session_ended',
    sessionId: session.id,
    message: `Session ${session.id} has ended (${session.state}); ${consequence}`,
  });
}

/**
 * Throws a `SessionError` unless `session` is idle: only an idle session can take its next
 * prompt, and a running or ended one says which it is.
 */
export function assertIdle(session: SessionInfo): void {
  if (session.state === 'idle') return;

  throw new SessionError({
    reason: session.state === 'running' ? 'session_running' : 'session_ended',
    sessionId: session.id,
    message: `Session ${session.id} is ${session.state}; only an idle session can take its next prompt`,
  });
}

/**
 * Throws a `SessionError` unless `from` may message `session`: it must still be open, and a
 * sender other than the user must be one of its ancestors (`lineage` is the session and every
 * ancestor), since a session steers only its own sub-agents and theirs.
 */
export function assertCanSend(params: {
  session: SessionInfo;
  from: InboxMessage['from'];
  lineage: readonly SessionInfo[];
}): void {
  const { session, from, lineage } = params;

  assertOpen({ session, consequence: "it can't receive messages" });

  // A sub-agent is steered by the agent that started it, never by the user: whatever reaches it
  // as a `user` message must come from an ancestor session.
  if (from === 'user' && session.depth > 1) {
    throw new SessionError({
      reason: 'not_an_ancestor',
      sessionId: session.id,
      message: `Session ${session.id} is a sub-agent: only the agent that started it can message it`,
    });
  }

  if (from !== 'user' && !lineage.some((s) => s.id === from && s.id !== session.id)) {
    throw new SessionError({
      reason: 'not_an_ancestor',
      sessionId: session.id,
      message: `Session ${from} did not start session ${session.id} (directly or through a sub-agent)`,
    });
  }
}

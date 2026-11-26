import type { SessionId } from '@sheavly/protocol/session/session.types';

/** Why a session operation was refused. */
type SessionFailure =
  | 'unknown_session'
  | 'duplicate_session'
  | 'session_released'
  | 'parent_ended'
  | 'too_deep'
  | 'session_ended'
  | 'session_running'
  | 'not_an_ancestor'
  | 'outbox_full'
  | 'inbox_full'
  | 'invalid_notice';

/**
 * A session operation was refused: an unknown or released session, a session started or stored
 * under an id a live session already has (`duplicate_session`), a parent or target that has
 * ended, a sub-agent nested too deep, a message from a session that didn't start its target, an
 * extension notice that is malformed, one queued while the session's outbox is full, or a message
 * sent while its inbox is (`inbox_full`).
 */
export class SessionError extends Error {
  override name = 'SessionError';
  readonly reason: SessionFailure;
  /** The session the operation was about. */
  readonly sessionId: SessionId;

  constructor(params: { reason: SessionFailure; sessionId: SessionId; message: string }) {
    const { reason, sessionId, message } = params;

    super(message);
    this.reason = reason;
    this.sessionId = sessionId;
  }
}

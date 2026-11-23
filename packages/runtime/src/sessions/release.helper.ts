import type { SessionId, SessionInfo } from '@sheavly/protocol/session/session.types';
import { SessionError } from '../errors/sessions.errors.js';
import type { SessionNodes } from './session-nodes.service.js';

/**
 * Removes the ended session `id` and every sub-agent under it from `sessions`, and has each of
 * `holders` forget them too. Returns the sessions that went, as they last were. Throws
 * `session_running` before removing anything if one of them is still open, or if a command, a
 * service or other work started under one of them is (`openBelow`).
 */
export function releaseSubtree(params: {
  id: SessionId;
  sessions: SessionNodes;
  holders: { forget: (id: SessionId) => void }[];
}): SessionInfo[] {
  const { id, sessions, holders } = params;
  const open = sessions.openBelow(id);

  if (open) {
    throw new SessionError({
      reason: 'session_running',
      sessionId: open.id,
      message: `Session ${open.id} (${open.state}) or work under it is still open; only ended sessions can be released`,
    });
  }

  const released = sessions.release(id);

  for (const session of released) {
    for (const holder of holders) holder.forget(session.id);
  }

  return released;
}

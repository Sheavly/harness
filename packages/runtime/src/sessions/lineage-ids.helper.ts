import type { SessionId, SessionInfo } from '@sheavly/protocol/session/session.types';
import type { ReleasedSessions } from './released-sessions.service.js';

/** Where the lineage reads a live session from: the registry's own sessions. */
type LiveSessions = { get: (id: SessionId) => SessionInfo | undefined };

/** The session that started `id`, live or released; none for a main session or an unknown id. */
function parentOf(params: {
  id: SessionId;
  sessions: LiveSessions;
  released: ReleasedSessions;
}): SessionId | undefined {
  const { id, sessions, released } = params;
  const live = sessions.get(id);

  if (!live) return released.parentOf(id);

  return 'parentId' in live ? live.parentId : undefined;
}

/** `id` and every live ancestor, up to the main session (last), each a copy. */
export function lineageOf(params: { id: SessionId; sessions: LiveSessions }): SessionInfo[] {
  const { id, sessions } = params;
  const chain: SessionInfo[] = [];
  let current = sessions.get(id);

  while (current) {
    chain.push({ ...current });
    current = 'parentId' in current ? sessions.get(current.parentId) : undefined;
  }

  return chain;
}

/** `id` and its ancestors' ids up to the main session, through released sessions too. */
export function lineageIds(params: {
  id: SessionId;
  sessions: LiveSessions;
  released: ReleasedSessions;
}): SessionId[] {
  const ids: SessionId[] = [];
  let current: SessionId | undefined = params.id;

  while (current !== undefined) {
    ids.push(current);
    current = parentOf({ ...params, id: current });
  }

  return ids;
}

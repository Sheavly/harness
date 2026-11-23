import { StoreError } from '@sheavly/core/errors/store.errors';
import type { EntryStore } from '@sheavly/core/store/store.types';
import type {
  SessionId,
  SessionInfo,
  SessionUpdate,
} from '@sheavly/protocol/session/session.types';
import type { StreamEntry } from '@sheavly/protocol/stream/stream.types';
import { LastTokens } from './last-tokens.service.js';
import { MessageContexts } from './message-contexts.service.js';
import { ENTRY_TAIL_SIZE } from './sessions.constants.js';
import type { StoredLog } from './sessions.types.js';

/**
 * Keeps the session a stored update is about as its last update left it. A released session is no
 * longer a live one: it moves to `released`, as it left the registry in process.
 */
function keepSession(params: {
  update: SessionUpdate;
  sessions: Map<SessionId, SessionInfo>;
  released: Map<SessionId, SessionInfo>;
}): void {
  const { update, sessions, released } = params;
  const { session } = update;

  if (update.type !== 'session_released') {
    sessions.set(session.id, session);

    return;
  }

  sessions.delete(session.id);
  released.set(session.id, session);
}

/**
 * What a registry needs to carry on a conversation that was stored: where the numbering resumes,
 * the newest entries (kept in memory as a live log keeps them), and each session as its last
 * update left it, sub-agents included. Reads every entry once, in order; a gap means a write was
 * lost, so it throws a `StoreError` instead of resuming a conversation with a hole in it.
 */
export async function readStoredLog(store: EntryStore): Promise<StoredLog> {
  const tail: StreamEntry[] = [];
  const sessions = new Map<SessionId, SessionInfo>();
  const released = new Map<SessionId, SessionInfo>();
  const lastTokens = new LastTokens();
  const messageContexts = new MessageContexts();
  let next = 0;

  for await (const entry of store.read()) {
    if (entry.seq !== next) {
      throw new StoreError({
        reason: 'failed',
        message: `Stored entries skip from ${String(next)} to ${String(entry.seq)}`,
      });
    }

    next++;
    tail.push(entry);
    if (tail.length > ENTRY_TAIL_SIZE) tail.shift();
    if (entry.kind === 'update') keepSession({ update: entry.update, sessions, released });
    if (entry.kind === 'event') lastTokens.observe(entry);
    messageContexts.observe(entry);
  }

  return {
    next,
    tail,
    sessions: [...sessions.values()],
    ...(released.size > 0 && { released: [...released.values()] }),
    lastTokens: lastTokens.entries(),
    ...(messageContexts.snapshot.length > 0 && { messageContexts: messageContexts.snapshot }),
  };
}

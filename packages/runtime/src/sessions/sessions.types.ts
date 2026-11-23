import type { SessionRegistry } from './sessions.service.js';
import type { SessionId, SessionInfo, SessionRef } from '@sheavly/protocol/session/session.types';
import type { PersistentNotice } from '@sheavly/protocol/notice/notice.types';
import type { StreamEntry } from '@sheavly/protocol/stream/stream.types';
import type { TokenUsage } from '@sheavly/protocol/usage/usage.types';
import type { MessageId } from '@sheavly/protocol/message/message.types';

/**
 * An extension's notice, already checked by the extension host, waiting in a session's outbox
 * for its loop to publish it.
 */
export type QueuedNotice = Extract<PersistentNotice, { kind: 'extension-notice' }>;

/** A session's originating user message, retained when its parent starts another prompt. */
export type SessionMessage = { sessionId: SessionId; messageId: MessageId };

/** The tokens a session's last model call reported. */
export type SessionTokens = { sessionId: SessionId; tokens: TokenUsage };

/** The session a run belongs to: which registry it is tracked in, and which session it is. */
export type RunSession = {
  registry: SessionRegistry;
  ref: SessionRef;
};

/**
 * What a stored conversation leaves for a registry to carry on from (`readStoredLog`): the `seq`
 * the next entry gets, the newest entries as a live log keeps them, every live session as its last
 * update left it, the sessions that had been released (as they last were: they come back as
 * released, not live, so a long conversation does not carry every sub-agent it ever had), and what
 * each one's last model call reported.
 */
export type StoredLog = {
  next: number;
  tail: StreamEntry[];
  sessions: SessionInfo[];
  released?: SessionInfo[];
  lastTokens: SessionTokens[];
  messageContexts?: SessionMessage[];
};

/**
 * Which entries of the combined stream a listener gets. No `sessionId`: every session's. With
 * one: that session's, and with `subtree` also its sub-agents' (and theirs). `replay` first sends
 * every matching entry so far, so a UI that opens a sub-agent's panel late sees it from its start.
 */
export type EntryFilter = {
  sessionId?: SessionId;
  subtree?: boolean;
  replay?: boolean;
};

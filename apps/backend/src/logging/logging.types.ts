import type { Logger } from '@sheavly/logger/logger/logger.types';
import type { ConversationId } from '@sheavly/protocol/server/server.types';

/**
 * The backend's loggers. Each entry goes to stderr (a JSON line, through the app's `log`) and to a
 * file under the user's home: a conversation's own `log.jsonl`, or the server's `backend.jsonl`
 * for what has no conversation.
 */
export type BackendLogs = {
  /** For a failure that belongs to no conversation (startup, shutdown). */
  server: Logger;
  /** For one conversation: every entry carries its `conversationId`. */
  conversation: (id: ConversationId) => Logger;
};

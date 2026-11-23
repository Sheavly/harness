import { createLogger } from '@sheavly/logger/logger/logger.helper';
import type { LogEntry, LogSink } from '@sheavly/logger/logger/logger.types';
import type { ConversationId } from '@sheavly/protocol/server/server.types';
import type { FileConversationStore } from '@sheavly/storage/conversation-store/conversation-store.service';
import type { BackendLogs } from '../logging/logging.types.js';

/** Test-only: logs that write to `sink`, the conversation's entries carrying its id. */
function logsTo(sink: (id?: ConversationId) => LogSink): BackendLogs {
  return {
    server: createLogger({ service: 'backend', sinks: [sink()] }),
    conversation: (id) =>
      createLogger({ service: 'backend', sinks: [sink(id)] }).child({ conversationId: id }),
  };
}

/** Test-only: logs that keep every entry in memory, for a test that reads what was logged. */
export function collectingLogs(): { logs: BackendLogs; entries: LogEntry[] } {
  const entries: LogEntry[] = [];

  return { logs: logsTo(() => (entry) => void entries.push(entry)), entries };
}

/** Test-only: logs that write nowhere, for a test that does not read them. */
export function silentLogs(): BackendLogs {
  return logsTo(() => () => undefined);
}

/**
 * Test-only: logs that write each conversation's entries to its own `log.jsonl` in `store`, as the
 * backend does; the server's go nowhere.
 */
export function storeLogs(store: FileConversationStore): BackendLogs {
  return logsTo((id) => (id === undefined ? () => undefined : store.logSink(id)));
}

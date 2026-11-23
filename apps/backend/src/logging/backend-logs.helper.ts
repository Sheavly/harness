import { redactDiagnosticText } from '@sheavly/core/text/diagnostic-text.utils';
import { createLogger } from '@sheavly/logger/logger/logger.helper';
import type { LogSink, SinkFailure } from '@sheavly/logger/logger/logger.types';
import { errorMessage } from '@sheavly/runtime/errors/errors.utils';
import { serverLogSink } from '@sheavly/storage/server-log/server-log.helper';
import type { PlacedConversationStore } from '../profiles/placed-conversation-store.service.js';
import { LOG_SERVICE } from './logging.constants.js';
import type { BackendLogs } from './logging.types.js';

/** One JSON line on `log` (stderr): JSON escapes control characters, so it is safe on a terminal. */
function stderrSink(log: (text: string) => void): LogSink {
  return (entry) => log(`${JSON.stringify(entry)}\n`);
}

/**
 * The backend's loggers over `home` (the user's folder) and `places`, which knows where each
 * conversation is kept. A conversation nothing placed (a failure before it started, an id nobody
 * has) is logged to the server's file instead, so no failure goes only to stderr. A sink that
 * fails is told on `log`, once per entry, and never reaches the caller.
 */
export function createBackendLogs(params: {
  home: string;
  places: PlacedConversationStore;
  log: (text: string) => void;
}): BackendLogs {
  const { home, places, log } = params;
  const server = serverLogSink({ home });
  const stderr = stderrSink(log);
  const options = {
    service: LOG_SERVICE,
    onSinkFailure: ({ position, error }: SinkFailure) =>
      log(
        `Could not write a log entry (sink ${String(position)}): ${redactDiagnosticText(errorMessage(error))}\n`,
      ),
  };

  return {
    server: createLogger({ ...options, sinks: [server, stderr] }),
    conversation: (id) =>
      createLogger({
        ...options,
        sinks: [places.logSink({ id, otherwise: server }), stderr],
      }).child({ conversationId: id }),
  };
}

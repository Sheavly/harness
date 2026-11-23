/** The folder under the user's home that holds the server's own logs. */
export const SERVER_LOG_FOLDER = 'logs';

/**
 * The server's log, one `LogEntry` per line: failures with no conversation to put them in
 * (startup, an extension that failed to deactivate). A conversation's own are in its `log.jsonl`.
 */
export const SERVER_LOG_FILE = 'backend.jsonl';

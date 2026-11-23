import path from 'node:path';
import type { LogSink } from '@sheavly/logger/logger/logger.types';
import { OrderedAppends } from '../jsonl-file/ordered-appends.service.js';
import { assertSafeRoot } from '../safe-path/safe-path.helper.js';
import { SERVER_LOG_FILE, SERVER_LOG_FOLDER } from './server-log.constants.js';

/**
 * Where the server's own log entries go: `<home>/logs/backend.jsonl`, private to the user, made on
 * the first entry. `home` is the user's folder (`sheavlyHome`); it must be absolute and not the
 * top of a file system. Lines are written in the order they are given, even when the caller does
 * not wait for each. The file is never trimmed or rotated: a person deletes it.
 */
export function serverLogSink(params: { home: string }): LogSink {
  const file = path.join(assertSafeRoot(params.home), SERVER_LOG_FOLDER, SERVER_LOG_FILE);
  const appends = new OrderedAppends({ file });

  return (entry) => appends.append({ value: entry });
}

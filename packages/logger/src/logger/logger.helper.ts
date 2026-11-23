import { now } from '@sheavly/core/clock/clock.helper';
import { DEFAULT_LOG_LEVEL, LOG_LEVEL, NO_SINK } from './logger.constants.js';
import type { CreateLoggerOptions, LogEntry, LogFields, Logger, LogLevel } from './logger.types.js';
import { createLogEntry, isEnabled } from './logger.utils.js';

/**
 * Gives `entry` to every sink. A sink that throws or rejects is told to `onSinkFailure` and the
 * other sinks still get the entry: logging must never break the work it describes. An async sink
 * is not awaited, so entries are written in the background; one sink keeps its own order.
 */
function deliver(params: {
  sinks: CreateLoggerOptions['sinks'];
  entry: LogEntry;
  onSinkFailure: CreateLoggerOptions['onSinkFailure'];
}): void {
  const { sinks, entry, onSinkFailure } = params;

  sinks.forEach((sink, position) => {
    const report = (error: unknown) => onSinkFailure?.({ position, error });

    try {
      // Not `await`: the caller must not wait for a slow sink, and a rejection is reported here.
      Promise.resolve(sink(entry)).catch(report);
    } catch (caughtError) {
      report(caughtError);
    }
  });
}

type Bound = CreateLoggerOptions & { bound: LogFields };

function build(params: Bound): Logger {
  const { service, level: minimum = DEFAULT_LOG_LEVEL, sinks, onSinkFailure, bound } = params;
  const write = (level: LogLevel) => (event: string, fields?: LogFields) => {
    if (!isEnabled({ level, minimum })) return;

    try {
      deliver({
        sinks,
        entry: createLogEntry({
          service,
          level,
          event,
          time: now(),
          fields: { ...bound, ...fields },
        }),
        onSinkFailure,
      });
    } catch (caughtError) {
      // The entry could not be made (a value no redaction expected): logging must not break the
      // work it describes, so the failure goes where a failed sink's does, with no sink position.
      onSinkFailure?.({ position: NO_SINK, error: caughtError });
    }
  };

  return {
    debug: write(LOG_LEVEL.DEBUG),
    info: write(LOG_LEVEL.INFO),
    warn: write(LOG_LEVEL.WARN),
    error: write(LOG_LEVEL.ERROR),
    child: (fields) => build({ ...params, bound: { ...bound, ...fields } }),
  };
}

/**
 * A logger writing to `sinks`. Every entry is redacted once before any sink sees it, and its
 * fields are the closed `LOG_FIELD` list. It reads no env and does no terminal I/O.
 */
export function createLogger(options: CreateLoggerOptions): Logger {
  return build({ ...options, bound: {} });
}

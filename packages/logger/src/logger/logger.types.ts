import type { ErrorDetails } from '@sheavly/protocol/event/event.types';
import type { LOG_FIELD, LOG_FIELD_KIND, LOG_LEVEL } from './logger.constants.js';

export type LogLevel = (typeof LOG_LEVEL)[keyof typeof LOG_LEVEL];

type LogFieldKey = keyof typeof LOG_FIELD;

/** What each kind of field holds (`LOG_FIELD_KIND` says what the kinds mean). */
type LogFieldValues = {
  readonly [LOG_FIELD_KIND.TEXT]: string;
  readonly [LOG_FIELD_KIND.COUNT]: number;
  readonly [LOG_FIELD_KIND.ERROR]: unknown;
  readonly [LOG_FIELD_KIND.DETAILS]: ErrorDetails;
};

/**
 * The fields of a log call or of a child logger: only the keys of `LOG_FIELD`, each with the type
 * of its kind. An object literal with any other key does not compile, which is the allow-list.
 */
export type LogFields = {
  readonly [TKey in LogFieldKey]?: LogFieldValues[(typeof LOG_FIELD)[TKey]] | undefined;
};

/** A caught value as an entry holds it: the captured error details and its message, redacted. */
export type ErrorRecord = ErrorDetails & { readonly message: string };

/**
 * The redacted entry every sink receives: the level, the event name, the time (epoch
 * milliseconds), the service and the allowed fields, an `error` as an `ErrorRecord`. It is frozen
 * and shared by all sinks: a sink reads it and never changes it.
 */
export type LogEntry = {
  readonly [key: string]: unknown;
  readonly level: LogLevel;
  readonly event: string;
  readonly time: number;
  readonly service: string;
};

/**
 * A destination of entries: a file, the terminal, a test. It may be async; a throw or a rejection
 * is isolated (`createLogger` says how it is reported) and never reaches the caller or another sink.
 */
export type LogSink = (entry: LogEntry) => void | Promise<void>;

/**
 * One sink that threw or rejected: its position in `sinks` and what it threw. A `position` of `-1`
 * means no sink: the entry could not be made, and nothing was written.
 */
export type SinkFailure = { readonly position: number; readonly error: unknown };

/**
 * A logger. An `event` is a member of the calling module's `LOG_EVENT` (`harness/log-event-name`
 * checks the literal): a lowercase dotted `<area>.<what_happened>`.
 */
export type Logger = {
  readonly debug: (event: string, fields?: LogFields) => void;
  readonly info: (event: string, fields?: LogFields) => void;
  readonly warn: (event: string, fields?: LogFields) => void;
  /** Pass the caught value as `error`: it is serialized with its stack and cause chain. */
  readonly error: (event: string, fields?: LogFields) => void;
  /** A logger that adds the same fields to every entry (a conversation id). */
  readonly child: (fields: LogFields) => Logger;
};

export type CreateLoggerOptions = {
  /** Who writes: `backend`, `storage`. It is on every entry. */
  service: string;
  /** The minimum level written; default `info`. */
  level?: LogLevel | undefined;
  /** Where entries go. The logger reads no env and does no I/O of its own: sinks are passed in. */
  sinks: readonly LogSink[];
  /**
   * Told of each sink that threw and of an entry that could not be made, since the caller is not.
   * It must not throw: nothing is left to tell, and it would reach the caller (or, for an async
   * sink, be an unhandled rejection).
   */
  onSinkFailure?: ((failure: SinkFailure) => void) | undefined;
};

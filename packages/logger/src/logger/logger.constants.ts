/** The level of a log line: the `Logger` method name and the minimum level of a logger. */
export const LOG_LEVEL = {
  DEBUG: 'debug',
  INFO: 'info',
  WARN: 'warn',
  ERROR: 'error',
} as const;

/** What a logger writes when no level is configured: `debug` only when somebody asks. */
export const DEFAULT_LOG_LEVEL = 'info' as const;

/** Lowest to highest: a logger writes a line whose rank is at least its minimum level's. */
export const LOG_LEVEL_RANK = {
  [LOG_LEVEL.DEBUG]: 10,
  [LOG_LEVEL.INFO]: 20,
  [LOG_LEVEL.WARN]: 30,
  [LOG_LEVEL.ERROR]: 40,
} as const;

/**
 * What a field holds, which is what its TypeScript type is (`LogFieldValues`): `text` is an id, a
 * code or the name of a thing that is not personal; `count` a number (a status, a size, a
 * duration, a position); `error` the caught value, serialized with its stack and cause chain;
 * `details` error details that were already captured (a stored `run_failed`).
 */
export const LOG_FIELD_KIND = {
  TEXT: 'text',
  COUNT: 'count',
  ERROR: 'error',
  DETAILS: 'details',
} as const;

/**
 * THE closed allow-list of log fields: the only keys a log call may pass, each with what it holds.
 * A key that is not here is a compile error at the call (an excess property of `LogFields`) and
 * is dropped at runtime, named in the entry's `droppedFields`. Ids, codes, counts and names of
 * things; never a body, a prompt, a row or free text. Adding a key is a reviewed decision: it
 * needs a reason (what the key answers when someone debugs a conversation) and no personal data
 * in its values (`.agents/skills/sheavly/logging.md`, "A log field").
 */
export const LOG_FIELD = {
  error: LOG_FIELD_KIND.ERROR,
  details: LOG_FIELD_KIND.DETAILS,
  conversationId: LOG_FIELD_KIND.TEXT,
  sessionId: LOG_FIELD_KIND.TEXT,
  messageId: LOG_FIELD_KIND.TEXT,
  modelId: LOG_FIELD_KIND.TEXT,
  toolCallId: LOG_FIELD_KIND.TEXT,
  toolName: LOG_FIELD_KIND.TEXT,
  hook: LOG_FIELD_KIND.TEXT,
  handler: LOG_FIELD_KIND.TEXT,
  extension: LOG_FIELD_KIND.TEXT,
  route: LOG_FIELD_KIND.TEXT,
  code: LOG_FIELD_KIND.TEXT,
  seq: LOG_FIELD_KIND.COUNT,
  status: LOG_FIELD_KIND.COUNT,
  durationMs: LOG_FIELD_KIND.COUNT,
  count: LOG_FIELD_KIND.COUNT,
} as const;

/** What replaces text that looks like a secret or identity data. */
export const REDACTED_MARKER = '[REDACTED]';

/**
 * Text that looks like identity data, in any string an entry holds: an e-mail address and a JWT.
 * The parts of an address are bounded (a local part is at most 64 characters, a domain label 63),
 * so a long run of address characters cannot make the match slow. Credentials in the usual forms
 * are `redactDiagnosticText`'s (`@sheavly/core`).
 */
export const IDENTITY_PATTERNS = [
  /[\p{L}\p{N}._%+-]{1,64}@[\p{L}\p{N}-]{1,63}(?:\.[\p{L}\p{N}-]{1,63})+/gu,
  /\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]*/g,
] as const;

/**
 * A run of 10 or more digits that may carry single dashes or spaces (a personal identity number, a
 * phone number), looked for in an error's text only: an id field can be all digits. A digit run
 * inside an id (next to letters or a further dash group) is left alone.
 */
export const DIGIT_RUN_PATTERNS = [
  /(?<![A-Za-z0-9-])(?:\d[ -]?){9,}\d(?![A-Za-z0-9]|-[A-Za-z0-9])/g,
] as const;

/** The `position` of a failure that is no sink's: the entry itself could not be made. */
export const NO_SINK = -1;

/** The most names of dropped fields an entry lists. */
export const MAX_DROPPED_FIELDS = 8;

/** The most characters of a `text` field an entry keeps. */
export const MAX_TEXT_FIELD_CHARS = 512;

/** The most characters of an error's message an entry keeps, cut before any pattern runs on it. */
export const MAX_ERROR_MESSAGE_CHARS = 8192;

/** The most characters of any string in an entry that a pattern is run on. */
export const MAX_STRING_CHARS = 16_384;

/** How deep captured error details are followed before the rest is replaced. */
export const MAX_REDACTION_DEPTH = 8;

/** What stands in for a value past `MAX_REDACTION_DEPTH`, which also ends a value that refers to itself. */
export const TRUNCATED_MARKER = '[truncated]';

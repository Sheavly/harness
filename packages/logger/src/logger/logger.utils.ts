import { redactDiagnosticText } from '@sheavly/core/text/diagnostic-text.utils';
import { errorDetails } from '@sheavly/runtime/errors/error-details.utils';
import {
  DIGIT_RUN_PATTERNS,
  IDENTITY_PATTERNS,
  LOG_FIELD,
  LOG_FIELD_KIND,
  LOG_LEVEL_RANK,
  MAX_DROPPED_FIELDS,
  MAX_ERROR_MESSAGE_CHARS,
  MAX_REDACTION_DEPTH,
  MAX_STRING_CHARS,
  MAX_TEXT_FIELD_CHARS,
  REDACTED_MARKER,
  TRUNCATED_MARKER,
} from './logger.constants.js';
import type { ErrorRecord, LogEntry, LogLevel } from './logger.types.js';

type FieldKey = keyof typeof LOG_FIELD;

/** Whether a logger whose minimum is `minimum` writes an entry of `level`. */
export function isEnabled(params: { level: LogLevel; minimum: LogLevel }): boolean {
  const { level, minimum } = params;

  return LOG_LEVEL_RANK[level] >= LOG_LEVEL_RANK[minimum];
}

/**
 * `text` cut to `max` characters, so no pattern is ever run on an unbounded string. A word the cut
 * went through is dropped whole: half a key is shorter than the pattern that would redact it.
 */
function cut(params: { text: string; max: number }): string {
  const { text, max } = params;

  if (text.length <= max) return text;

  const kept = text.slice(0, max);
  const lastBreak = Math.max(kept.lastIndexOf(' '), kept.lastIndexOf('\n'), kept.lastIndexOf('\t'));
  // A single word as long as the cut has no break to fall back to: drop all of it.
  const whole = /\s/.test(text[max] ?? '') ? kept : kept.slice(0, Math.max(lastBreak, 0));

  return `${whole}…`;
}

function replaceAll(params: { text: string; patterns: readonly RegExp[] }): string {
  return params.patterns.reduce(
    (result, pattern) => result.replace(pattern, REDACTED_MARKER),
    params.text,
  );
}

/**
 * A label (an id, a code, a name) with credentials (`redactDiagnosticText`), e-mail addresses and
 * JWTs replaced, and cut to `MAX_TEXT_FIELD_CHARS`. Digit runs stay: an id can be all digits.
 */
function redactLabel(text: string): string {
  const bounded = cut({ text, max: MAX_TEXT_FIELD_CHARS });

  return replaceAll({ text: redactDiagnosticText(bounded), patterns: IDENTITY_PATTERNS });
}

/**
 * An error's text with credentials, identity-shaped text and long digit runs (a personal identity
 * number, a phone number) replaced. A string longer than `MAX_STRING_CHARS` is cut first.
 */
export function redactText(text: string): string {
  const bounded = cut({ text, max: MAX_STRING_CHARS });

  return replaceAll({
    text: redactDiagnosticText(bounded),
    patterns: [...IDENTITY_PATTERNS, ...DIGIT_RUN_PATTERNS],
  });
}

/** A copy of plain data with every string redacted at any depth; numbers and booleans stay. */
function redactDeep(params: { value: unknown; depth: number }): unknown {
  const { value, depth } = params;

  if (typeof value === 'string') return redactText(value);

  if (typeof value !== 'object' || value === null) return value;

  // Also what ends a value that refers to itself.
  if (depth >= MAX_REDACTION_DEPTH) return TRUNCATED_MARKER;

  const next = (item: unknown) => redactDeep({ value: item, depth: depth + 1 });

  if (Array.isArray(value)) return value.map(next);

  return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, next(item)]));
}

/** The text of a thrown value without ever throwing: a value with no `toString` has none to give. */
function textOf(caught: unknown): string {
  if (typeof caught === 'string') return caught;

  if (caught instanceof Error) return typeof caught.message === 'string' ? caught.message : '';

  const kind = typeof caught;

  if (kind === 'number' || kind === 'boolean' || kind === 'bigint') return String(caught);

  return Object.prototype.toString.call(caught);
}

/**
 * The caught value as plain data: its name, code, stack and bounded cause chain (`errorDetails`)
 * and its message (cut to `MAX_ERROR_MESSAGE_CHARS`), all redacted. A value that is not an `Error`
 * has its text as the message.
 */
export function errorRecord(caught: unknown): ErrorRecord {
  const message = cut({ text: textOf(caught), max: MAX_ERROR_MESSAGE_CHARS });

  return redactDeep({ value: { ...errorDetails(caught), message }, depth: 0 }) as ErrorRecord;
}

function isFieldKey(key: string): key is FieldKey {
  return Object.hasOwn(LOG_FIELD, key);
}

/**
 * One allowed field's value as the entry holds it, by what the field is, or `undefined` when the
 * value is not what its kind holds (an object in a `text` field, a `NaN` count): it is dropped,
 * never written as it came.
 */
function fieldValue(params: { key: FieldKey; value: unknown }): unknown {
  const { key, value } = params;
  const kind = LOG_FIELD[key];

  if (kind === LOG_FIELD_KIND.ERROR) return errorRecord(value);

  if (kind === LOG_FIELD_KIND.DETAILS) return redactDeep({ value, depth: 0 });

  if (kind === LOG_FIELD_KIND.COUNT) {
    return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
  }

  return typeof value === 'string' ? redactLabel(value) : undefined;
}

/**
 * The entry a sink receives: the level, event, time and service, then each allowed field. Every
 * string in it has been redacted here, the one place an entry is made safe, before any sink sees
 * it. A key that is not in `LOG_FIELD`, or whose value is not what its field holds, is not written
 * and is named in `droppedFields`: the types refuse both at the call, so this is the net for a
 * caller the compiler did not see.
 */
export function createLogEntry(params: {
  service: string;
  level: LogLevel;
  event: string;
  /** Epoch milliseconds. */
  time: number;
  fields: object;
}): LogEntry {
  const { service, level, event, time, fields } = params;
  const written: Record<string, unknown> = {};
  const dropped: string[] = [];

  for (const [key, value] of Object.entries(fields)) {
    if (value === undefined) continue;

    const safe = isFieldKey(key) ? fieldValue({ key, value }) : undefined;

    if (safe === undefined) {
      // A key the compiler never saw can be anything (an address, a token): redacted, and few.
      if (dropped.length < MAX_DROPPED_FIELDS) dropped.push(redactLabel(key));
    } else {
      written[key] = safe;
    }
  }

  const entry: LogEntry = {
    level,
    event,
    time,
    service,
    ...written,
    ...(dropped.length > 0 && { droppedFields: dropped }),
  };

  // Shared by every sink: none may change what another receives.
  return Object.freeze(entry);
}

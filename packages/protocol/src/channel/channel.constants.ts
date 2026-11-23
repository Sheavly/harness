/**
 * A sequence cursor: `s` and the position of an entry in a channel that numbers its entries, 0, 1,
 * 2, … with no gaps. Written as text so a client keeps it whole and sends it back, never does
 * arithmetic on it, and so a cursor of the wrong kind for its channel can be told apart. At most
 * fifteen digits: below 2^53, so the number is exact when it is read back.
 */
export const SEQUENCE_CURSOR_PATTERN = /^s(?:0|[1-9]\d{0,14})$/;

/**
 * A byte cursor: `b` and the offset in bytes into the output of a command or a service. At most
 * fifteen digits, as a sequence cursor is.
 */
export const BYTE_CURSOR_PATTERN = /^b(?:0|[1-9]\d{0,14})$/;

/** The longest an entry's `type` may be: a name, as an extension's `<extension>.<name>` is. */
export const MAX_ENTRY_TYPE_CHARS = 128;

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

/**
 * The most bytes of a command's or a service's output one `output` entry carries: 16 KiB of UTF-8.
 * Small enough that a client shows output as it comes and a slow one holds little for each frame,
 * and one read (`MAX_TAIL_BYTES`, the output store's read bound) is several of them. An entry is
 * not stored, so it is not held to `MAX_CHANNEL_ENTRY_CHARS`: a chunk of control characters is up to
 * six times its size as JSON, which a subscription counts against what a conversation may hold.
 */
export const MAX_OUTPUT_CHUNK_BYTES = 16_384;

/**
 * The most one entry of a channel may be as stored: its JSON, in characters. A node and an
 * extension's `data` (`MAX_EXTENSION_DATA_BYTES`, 16 KiB) fit with room to spare, and it is far
 * under the line a stored file can be read back (storage's `MAX_LINE_CHARS`, which a test pins), so
 * a store never keeps an entry it could not read. A store refuses a longer one; it never cuts it.
 */
export const MAX_CHANNEL_ENTRY_CHARS = 65_536;

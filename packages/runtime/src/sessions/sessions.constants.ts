/** Sessions nest at most this deep: main session → sub-agent → sub-agent. A hard cap. */
export const MAX_SESSION_DEPTH = 3;

/**
 * How many extension notices one session's outbox holds before the loop drains it at its next
 * turn. An idle session keeps them for its next prompt, so without a cap an extension could grow
 * it without bound; past it, `queueNotice` throws.
 */
export const MAX_QUEUED_NOTICES = 100;

/**
 * How many messages one session's inbox holds before its loop takes them at its next model call,
 * and how many characters they hold together. An idle session keeps them for its next prompt, so
 * without bounds a client sending to it (the API's `POST …/messages`) could grow it without limit;
 * past either, while others wait, `send` throws `inbox_full`, and the sender tries again once the
 * session has taken them. A message sent to an empty inbox is always queued, however long.
 */
export const MAX_QUEUED_MESSAGES = 100;
export const MAX_QUEUED_MESSAGE_CHARS = 400_000;

/**
 * How many of the newest entries a log keeps in memory: enough for a UI that reconnects from its
 * last event id to catch up without reading the disk. Older ones are read from the store, or
 * gone when there is none.
 */
export const ENTRY_TAIL_SIZE = 1000;

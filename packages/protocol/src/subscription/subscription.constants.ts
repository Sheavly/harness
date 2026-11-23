/** The most channels one subscribe request may follow. Past it the request is refused, not cut. */
export const MAX_SUBSCRIPTIONS = 32;

/**
 * The most entries `tail:<n>` may ask for on a channel that numbers its entries, the tree
 * channel's and an agent's: enough for a screenful of history, not a whole log. The schema applies
 * it to the tree channel; the server applies it to an agent's, which only it can tell apart.
 */
export const MAX_TAIL = 1_000;

/**
 * The most bytes `tail:<n>` may ask for on the output of a command or a service, and the most one
 * read of it may return: the output store's own read bound (`MAX_READ_BYTES`), pinned equal by a
 * test. It is also the largest `n` the schema takes for a channel whose kind it cannot see.
 */
export const MAX_TAIL_BYTES = 65_536;

/** `tail:` and a whole number of at least 1, at most fifteen digits so it is exact when read. */
export const TAIL_PATTERN = /^tail:[1-9]\d{0,14}$/;

/** The text before the number in a `tail` position. */
export const TAIL_PREFIX = 'tail:';

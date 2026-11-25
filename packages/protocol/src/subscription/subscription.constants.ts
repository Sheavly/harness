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

/**
 * The server-sent event name of a frame that says where a channel stood when a subscription at
 * `now` opened. It is also the `type` of that frame's data. A frame that carries an entry of a
 * channel is named `entry`, as on the stream (`ENTRY_EVENT`).
 */
export const HEAD_EVENT = 'head';

/** The event name, and the `type`, of the frame that ends one channel of a subscription. */
export const END_EVENT = 'end';

/**
 * The event name, and the `type`, of the frame that holds the tree as it stands: what a
 * subscription to the tree channel from `snapshot` sends first, before the entries after its
 * cursor.
 */
export const SNAPSHOT_EVENT = 'snapshot';

/**
 * Why a channel of a subscription ended. `completed`: its `closed` entry was delivered and nothing
 * follows. `cut_off`: this consumer did not keep up with it, or what the conversation's
 * subscriptions hold for their consumers left no room for it, so it stopped and the client resumes
 * from the cursor the frame carries. `failed`: no more of its entries will come: storing the channel
 * failed, or no writer has it. A reopened conversation closes such a channel as `lost`. The other
 * channels go on.
 */
export const CHANNEL_END_REASONS = ['completed', 'cut_off', 'failed'] as const;

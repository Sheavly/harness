/**
 * The most subscriptions one conversation serves at once. A subscription at `now` on a channel
 * nothing writes to is a connection held for as long as its client stays, so the number is bounded;
 * a request past it is refused (`too_many_subscriptions`), and the client asks again when one ends.
 */
export const MAX_SUBSCRIPTION_CONNECTIONS = 64;

/**
 * The most stored history one subscribe request may hold for delivery, summed over its channels: the
 * JSON length of the entries it will send first. A request that would hold more is refused
 * (`bad_request`), never cut: the client subscribes from a cursor or a tail instead. Reading what it
 * does not send (the log before a cursor, a tail's older entries) is not counted.
 */
export const MAX_SUBSCRIBE_READ_BYTES = 8 * 1024 * 1024;

/**
 * The most bytes (the JSON length, not the heap, which is up to about twice it) the subscriptions of
 * one conversation hold, all together, for consumers that have not read them: the entries a read of
 * history keeps while it goes on, the history frames a request will send first and the live frames
 * waiting. What a read is told while it is paused (`early`, up to `MAX_QUEUED_FRAMES` events a
 * channel, shared with the writer) is not counted. A request whose history does not fit is refused (`too_many_subscriptions`, as one more
 * than the conversation can serve); a channel whose live frames do not fit is cut off, as one whose
 * consumer is too slow is, and its client resumes. The two control frames (`head`, `end`) are not
 * counted, so an end can always be sent. Frames are given back as they are read or the
 * subscription closes.
 */
export const MAX_HELD_BYTES = 128 * 1024 * 1024;

/**
 * What every channel that is not in the conversation is told, whatever the reason (another
 * conversation's, an unknown node, the tree channel that is not served yet), so a client learns
 * nothing about channels it cannot reach.
 */
export const NO_SUCH_CHANNEL = 'No such channel in this conversation';

/**
 * The most frames of one channel a subscription holds for a consumer that has not read them. Past it
 * that channel is cut off and its client resumes from the cursor of the last entry it got; the other
 * channels go on, so what the server holds per subscription stays bounded.
 */
export const MAX_QUEUED_FRAMES = 1000;

/** How many frames a queue has given before it drops them from its array, so a shift stays cheap. */
export const COMPACT_AFTER = 1024;

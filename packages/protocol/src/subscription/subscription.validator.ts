import { z } from 'zod';
import { channelNameSchema, cursorSchema } from '../channel/channel.validator.js';
import { cursorKind } from '../channel/channel.utils.js';
import { TREE_CHANNEL_NAME } from '../node/node.constants.js';
import { MAX_SUBSCRIPTIONS, MAX_TAIL_BYTES, TAIL_PATTERN } from './subscription.constants.js';
import { tailCount, tailLimit } from './subscription.utils.js';

/**
 * Where in a channel to start. `start`: the first entry. `now`: nothing that is already there,
 * only what comes. `tail:<n>`: the last `n` entries of a channel that numbers its entries, the
 * last `n` bytes of the output of a command or a service. `snapshot`, for the tree channel only:
 * the tree as it stands, then what follows. Or a cursor the client was given: what follows it.
 * The schema cannot see which kind a node's channel is, so it bounds `n` by `MAX_TAIL_BYTES` for
 * any channel and by `MAX_TAIL` on the tree channel only. The server must apply `tailLimit` of the
 * kind it resolves each channel to (`MAX_TAIL` for an agent's), and refuse a `tail` or cursor of
 * the wrong kind for its channel, before it reads anything. A position is refused, never clamped.
 */
export const subscribeFromSchema = z.union([
  z.literal('start'),
  z.literal('now'),
  z.literal('snapshot'),
  z
    .string()
    .regex(TAIL_PATTERN, 'must be tail: and a whole number of at least 1')
    .refine((from) => (tailCount(from) ?? 0) <= MAX_TAIL_BYTES, {
      error: `tail may ask for at most ${String(MAX_TAIL_BYTES)}`,
    }),
  cursorSchema,
]);

/** One channel to follow and where to start in it. */
const subscriptionSchema = z.object({ channel: channelNameSchema, from: subscribeFromSchema });

/** Whether the request follows the tree channel. */
const followsTree = (subscriptions: readonly { channel: string }[]) =>
  subscriptions.some(({ channel }) => channel === TREE_CHANNEL_NAME);

/**
 * `QUERY /conversations/:id/subscribe`: the channels to follow and where to start in each. The
 * server keeps no connection state, so on a reconnect a client sends its last cursor for each
 * channel again. `approvals`: this client answers approvals, so while it is connected one waits for
 * an answer; with none connected an approval is refused at once. It is a claim, not a check.
 *
 * The request holds together: at least one channel and at most `MAX_SUBSCRIPTIONS`, none twice,
 * `snapshot` only on the tree channel, the tree channel numbered (a byte offset or a tail over
 * `MAX_TAIL` on it is refused), and `approvals` only with the tree channel, where an approval can
 * be seen. Whether a channel is the conversation's, and whether a cursor is past the end or before
 * what the log still holds (`cursor_out_of_range`), only the server can tell.
 */
export const subscribeRequestSchema = z
  .object({
    subscriptions: z.array(subscriptionSchema).min(1).max(MAX_SUBSCRIPTIONS),
    approvals: z.boolean().exactOptional(),
  })
  .refine(
    ({ subscriptions }) =>
      new Set(subscriptions.map(({ channel }) => channel)).size === subscriptions.length,
    {
      error: 'a channel is followed once',
      path: ['subscriptions'],
    },
  )
  .refine(
    ({ subscriptions }) =>
      subscriptions.every(
        ({ channel, from }) => from !== 'snapshot' || channel === TREE_CHANNEL_NAME,
      ),
    { error: 'only the tree channel has a snapshot', path: ['subscriptions'] },
  )
  .refine(
    ({ subscriptions }) =>
      subscriptions
        .filter(({ channel }) => channel === TREE_CHANNEL_NAME)
        .every(({ from }) => {
          const tail = tailCount(from);

          if (tail !== undefined) return tail <= tailLimit('sequence');

          return !cursorSchema.safeParse(from).success || cursorKind(from) === 'sequence';
        }),
    {
      error: 'the tree channel is numbered: a sequence cursor, and a tail of at most MAX_TAIL',
      path: ['subscriptions'],
    },
  )
  .refine(({ subscriptions, approvals }) => approvals !== true || followsTree(subscriptions), {
    error: 'approvals needs the tree channel, where an approval is seen',
    path: ['approvals'],
  });

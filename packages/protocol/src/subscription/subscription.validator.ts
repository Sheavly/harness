import { z } from 'zod';
import { channelEntrySchema, channelNameSchema } from '../channel/channel.validator.js';
import { cursorSchema } from '../channel/cursor.validator.js';
import { cursorKind, isConversationChannel } from '../channel/channel.utils.js';
import { TREE_CHANNEL_NAME } from '../node/node.constants.js';
import { treeChannelEntrySchema, treeSnapshotSchema } from '../tree/tree.validator.js';
import { usageChannelEntrySchema, usageSnapshotSchema } from '../usage/usage-channel.validator.js';
import {
  CHANNEL_END_REASONS,
  END_EVENT,
  HEAD_EVENT,
  MAX_SUBSCRIPTIONS,
  MAX_TAIL_BYTES,
  TAIL_PATTERN,
} from './subscription.constants.js';
import { tailCount, tailLimit } from './subscription.utils.js';

/**
 * Where in a channel to start. `start`: the first entry. `now`: nothing that is already there,
 * only what comes. `tail:<n>`: the last `n` entries of a channel that numbers its entries, the
 * last `n` bytes of the output of a command or a service. `snapshot`, for a channel of the
 * conversation itself (the tree, usage): its view as it stands, then what follows. Or a cursor the client
 * was given: what follows it. The schema cannot see which kind a node's channel is, so it bounds
 * `n` by `MAX_TAIL_BYTES` for any channel and by `MAX_TAIL` on a channel of the conversation itself
 * only. The server must apply `tailLimit` of the
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
 * `snapshot` only on a channel of the conversation itself, those channels numbered (a byte offset
 * or a tail over `MAX_TAIL` on one is refused), and `approvals` only with the tree channel, where
 * an approval can be seen. Whether a channel is the conversation's, and whether a cursor is past the end or before
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
        ({ channel, from }) => from !== 'snapshot' || isConversationChannel(channel),
      ),
    { error: 'only a channel of the conversation itself has a snapshot', path: ['subscriptions'] },
  )
  .refine(
    ({ subscriptions }) =>
      subscriptions
        .filter(({ channel }) => isConversationChannel(channel))
        .every(({ from }) => {
          const tail = tailCount(from);

          if (tail !== undefined) return tail <= tailLimit('sequence');

          return !cursorSchema.safeParse(from).success || cursorKind(from) === 'sequence';
        }),
    {
      error:
        'a channel of the conversation itself is numbered: a sequence cursor, and a tail of at most MAX_TAIL',
      path: ['subscriptions'],
    },
  )
  .refine(({ subscriptions, approvals }) => approvals !== true || followsTree(subscriptions), {
    error: 'approvals needs the tree channel, where an approval is seen',
    path: ['approvals'],
  });

/**
 * Where a channel stood when a subscription at `now` opened: the cursor of the newest entry it
 * held. Sent first, once per such channel, so a client that hears no entry before the connection
 * drops still has a cursor to resume after, and misses nothing written meanwhile. Not an entry:
 * it is not in the channel's log.
 */
export const channelHeadFrameSchema = z.object({
  type: z.literal(HEAD_EVENT),
  channel: channelNameSchema,
  cursor: cursorSchema,
});

/**
 * One channel of a subscription ended (`CHANNEL_END_REASONS`), and no more frames of it follow;
 * the others go on, and the stream closes after the last. `cursor` is the cursor of the last frame
 * delivered for it, an entry's or the head's: a client that was cut off resumes after it. Absent
 * when nothing was delivered, and the client then asks again from the position it asked for.
 */
export const channelEndFrameSchema = z.object({
  type: z.literal(END_EVENT),
  channel: channelNameSchema,
  reason: z.enum(CHANNEL_END_REASONS),
  cursor: cursorSchema.exactOptional(),
});

/**
 * What one frame of a subscribe stream holds, as JSON: an entry of a channel (event `entry`; its
 * envelope carries its own channel and cursor), where a channel stood (`head`), the end of a
 * channel (`end`), or a conversation channel's view as it stands (`snapshot`: the tree's or
 * usage's). An entry is a node's channel's, or one of the conversation's own channels'. A frame has
 * no `id`: one id cannot carry several cursors, so a client keeps the last cursor of each channel
 * and sends them again on a reconnect.
 */
export const subscribeFrameSchema = z.union([
  channelEntrySchema,
  treeChannelEntrySchema,
  usageChannelEntrySchema,
  channelHeadFrameSchema,
  channelEndFrameSchema,
  treeSnapshotSchema,
  usageSnapshotSchema,
]);

import { MAX_TREE_NODES, USAGE_CHANNEL_NAME } from '@sheavly/protocol/node/node.constants';
import type { ConversationId } from '@sheavly/protocol/server/server.types';
import type { SubscribeFrame } from '@sheavly/protocol/subscription/subscription.types';
import {
  usageChannelEntrySchema,
  usageSnapshotSchema,
} from '@sheavly/protocol/usage/usage-channel.validator';
import type { UsageView } from '@sheavly/protocol/usage/usage.types';
import { applyUsageEntry, emptyUsage } from '@sheavly/protocol/usage/usage.utils';
import type { createClient } from '../client/client.helper.js';
import { followChannelView } from '../client/follow-view.helper.js';
import { AnswerError } from '../errors/client.errors.js';
import type { WatchedUsage } from './usage.types.js';

/**
 * `usage` after `frame`: the usage channel's snapshot is the usage as it stands and replaces it, an
 * entry of the channel is folded in by the protocol's one rule (`applyUsageEntry`, which leaves the
 * channel's opening and closing as they are), and any other frame changes nothing. The client never
 * adds a call up: an entry says what a node and the total now are.
 */
function foldFrame(params: { usage: UsageView; frame: SubscribeFrame }): UsageView {
  const { usage, frame } = params;

  if (frame.type === 'snapshot') {
    const snapshot = usageSnapshotSchema.safeParse(frame);

    return snapshot.success ? { total: snapshot.data.total, nodes: snapshot.data.nodes } : usage;
  }

  const entry = usageChannelEntrySchema.safeParse(frame);

  if (!entry.success) return usage;

  const next = applyUsageEntry({ usage, entry: entry.data });

  // A snapshot holds at most this many nodes, and a server that drops a node's record says so
  // (`evicted`): one that sends entries for more is off the contract, and the client does not keep
  // what it sends, as a hostile server could otherwise grow it without end.
  if (next.nodes.length > MAX_TREE_NODES) {
    throw new AnswerError({
      route: 'streamChannels',
      cause: `the usage holds more than ${String(MAX_TREE_NODES)} nodes`,
    });
  }

  return next;
}

/**
 * Follows conversation `id`'s usage: the snapshot first, then the usage channel's entries after it,
 * so `usage()` is what it has used as it stands (the total and each node's, the cache tokens and the
 * cost among them), and `onChange` is told each time it changes. The backend counts it and the
 * client only holds what it says, so there is nothing to dedupe: an entry told twice gives the same
 * usage. It follows as any conversation channel is followed (`followChannelView`).
 *
 * `ended` rejects with `ChannelFailedError` when the usage channel ends `failed` (storing it failed,
 * or its conversation closed), with `AnswerError` for usage off the contract (more nodes than a
 * snapshot holds), with a refusal, and with whatever `onChange` throws; it resolves when the channel
 * ends `completed` and when `signal` aborts, which ends it quietly.
 */
export async function watchUsage(params: {
  client: ReturnType<typeof createClient>;
  id: ConversationId;
  onChange: (usage: UsageView) => void;
  signal: AbortSignal;
}): Promise<WatchedUsage> {
  const watch = await followChannelView({
    ...params,
    channel: USAGE_CHANNEL_NAME,
    empty: emptyUsage(),
    fold: ({ view, frame }) => foldFrame({ usage: view, frame }),
  });

  return { usage: watch.view, ended: watch.ended };
}

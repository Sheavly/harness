import { MAX_TREE_NODES, TREE_CHANNEL_NAME } from '@sheavly/protocol/node/node.constants';
import type { ConversationId } from '@sheavly/protocol/server/server.types';
import type { SubscribeFrame } from '@sheavly/protocol/subscription/subscription.types';
import type { TreeView } from '@sheavly/protocol/tree/tree.types';
import { applyTreeEntry, emptyTree } from '@sheavly/protocol/tree/tree.utils';
import { treeChannelEntrySchema, treeSnapshotSchema } from '@sheavly/protocol/tree/tree.validator';
import type { createClient } from '../client/client.helper.js';
import { followChannelView } from '../client/follow-view.helper.js';
import { AnswerError } from '../errors/client.errors.js';
import type { WatchedTree } from './tree.types.js';

/**
 * `tree` after `frame`: the tree's snapshot is the tree as it stands and replaces it, an entry of
 * the tree channel is folded in by the protocol's one rule (`applyTreeEntry`, which leaves an entry
 * that changes nothing in the tree as it is), and any other frame, another channel's included,
 * changes nothing.
 */
function foldFrame(params: { tree: TreeView; frame: SubscribeFrame }): TreeView {
  const { tree, frame } = params;

  if (frame.type === 'snapshot') {
    const snapshot = treeSnapshotSchema.safeParse(frame);

    return snapshot.success
      ? { nodes: snapshot.data.nodes, approvals: snapshot.data.approvals }
      : tree;
  }

  const entry = treeChannelEntrySchema.safeParse(frame);

  if (!entry.success) return tree;

  const next = applyTreeEntry({ tree, entry: entry.data });

  // A snapshot holds at most this many nodes and as many approvals, and a host's registries refuse
  // past them: a server that sends entries for more is off the contract. The protocol's rule drops
  // an ended node nothing hangs from, but keeps open nodes and the parents of kept ones, which a
  // hostile server can pile up without end (each entry also costs a pass over all of them), so the
  // client does not keep what it sends.
  if (next.nodes.length > MAX_TREE_NODES || next.approvals.length > MAX_TREE_NODES) {
    throw new AnswerError({
      route: 'streamChannels',
      cause: `the tree holds more than ${String(MAX_TREE_NODES)} nodes or approvals`,
    });
  }

  return next;
}

/**
 * Follows conversation `id`'s tree: the snapshot first, then the tree channel's entries after it,
 * so `tree()` is the tree as it stands, and `onChange` is told each time it changes (not for an
 * entry that changes nothing in it). It follows as any conversation channel is followed
 * (`followChannelView`: a dropped connection resumes after the last entry, a position the server no
 * longer holds is asked for again from `snapshot`).
 *
 * With `approvals`, this client answers approvals while it is open (the claim of the subscribe
 * route): one asked is held for an answer instead of refused, and shows in `tree().approvals`.
 * `ended` rejects with `ChannelFailedError` when the tree channel ends `failed` (storing it failed, or
 * its conversation closed: nothing more will come, and the claim is gone), with `AnswerError` for a
 * tree off the contract (more nodes or more approvals than a snapshot holds), with a refusal, and
 * with whatever `onChange` throws; it resolves when the channel ends `completed` and when `signal`
 * aborts, which ends it quietly.
 */
export async function watchTree(params: {
  client: ReturnType<typeof createClient>;
  id: ConversationId;
  approvals?: boolean;
  onChange: (tree: TreeView) => void;
  signal: AbortSignal;
}): Promise<WatchedTree> {
  const { client, id, approvals, onChange, signal } = params;
  const watch = await followChannelView({
    client,
    id,
    channel: TREE_CHANNEL_NAME,
    empty: emptyTree(),
    fold: ({ view, frame }) => foldFrame({ tree: view, frame }),
    onChange,
    signal,
    ...(approvals !== undefined && { approvals }),
  });

  return { tree: watch.view, ended: watch.ended };
}

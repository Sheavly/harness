import { MAX_TREE_NODES, TREE_CHANNEL_NAME } from '@sheavly/protocol/node/node.constants';
import type { ConversationId } from '@sheavly/protocol/server/server.types';
import type { SubscribeFrame } from '@sheavly/protocol/subscription/subscription.types';
import type { TreeView } from '@sheavly/protocol/tree/tree.types';
import { applyTreeEntry, emptyTree } from '@sheavly/protocol/tree/tree.utils';
import { treeChannelEntrySchema, treeSnapshotSchema } from '@sheavly/protocol/tree/tree.validator';
import type { createClient } from '../client/client.helper.js';
import { subscribeChannels } from '../client/subscribe.helper.js';
import { AnswerError, ChannelFailedError, RefusedError } from '../errors/client.errors.js';
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

/** The server no longer holds the position the client resumed from: it asks for the tree afresh. */
const isOutOfRange = (error: unknown) =>
  error instanceof RefusedError && error.code === 'cursor_out_of_range';

/**
 * Follows conversation `id`'s tree: the snapshot first, then the tree channel's entries after it,
 * so `tree()` is the tree as it stands, and `onChange` is told each time it changes (not for an
 * entry that changes nothing in it). A dropped connection resumes after the last entry
 * (`subscribeChannels`), which gives the tree the snapshot of that moment would; a position the
 * server no longer holds (`cursor_out_of_range`) is asked for again from `snapshot`, which replaces
 * the tree. Resolves once the server has accepted the first connection.
 *
 * With `approvals`, this client answers approvals while it is open (the claim of the subscribe
 * route): one asked is held for an answer instead of refused, and shows in `tree().approvals`.
 * `ended` rejects with `ChannelFailedError` when the tree channel ends `failed` (storing it failed, or
 * its conversation closed: nothing more will come, and the claim is gone), with `AnswerError` for a
 * tree off the contract (more nodes or more approvals than a snapshot holds), with a refusal, and with whatever
 * `onChange` throws; it resolves when the channel ends `completed` and when `signal` aborts, which
 * ends it quietly.
 */
export async function watchTree(params: {
  client: ReturnType<typeof createClient>;
  id: ConversationId;
  approvals?: boolean;
  onChange: (tree: TreeView) => void;
  signal: AbortSignal;
}): Promise<WatchedTree> {
  const { client, id, approvals, onChange, signal } = params;
  let tree = emptyTree();
  const open = (from: string) =>
    subscribeChannels({
      client,
      id,
      subscriptions: [{ channel: TREE_CHANNEL_NAME, from }],
      signal,
      ...(approvals !== undefined && { approvals }),
    });
  const follow = async (frames: AsyncGenerator<SubscribeFrame>): Promise<void> => {
    for await (const frame of frames) {
      // The channel failed: storing it failed, or its conversation closed. What was read is not all
      // of it, and the connection, with the claim to answer approvals, is gone: a UI must be told.
      if (frame.type === 'end' && frame.reason === 'failed') {
        throw new ChannelFailedError({ channel: TREE_CHANNEL_NAME });
      }

      const next = foldFrame({ tree, frame });

      if (next === tree) continue;

      tree = next;
      onChange(tree);
    }
  };
  const run = async (first: AsyncGenerator<SubscribeFrame>): Promise<void> => {
    let frames = first;

    for (;;) {
      try {
        await follow(frames);

        return;
      } catch (caughtError) {
        if (signal.aborted) return;

        if (!isOutOfRange(caughtError)) throw caughtError;
      }

      // The server no longer holds the position: the tree is asked for afresh. An abort while it is
      // being opened is the caller leaving, not a failure.
      try {
        frames = await open('snapshot');
      } catch (caughtError) {
        if (signal.aborted) return;

        throw caughtError;
      }
    }
  };

  return { tree: () => tree, ended: run(await open('snapshot')) };
}

import type { ApprovalId } from '@sheavly/protocol/approval/approval.types';
import type { ConversationId } from '@sheavly/protocol/server/server.types';
import type { TreeView } from '@sheavly/protocol/tree/tree.types';
import type { createClient } from '../client/client.helper.js';
import { watchTree } from '../tree/watch-tree.helper.js';
import type { TreeApproval } from './approvals.types.js';

/**
 * Tells `onApproval` of each approval in `tree` that has not been told of, and `onGone` of each that
 * was and is no longer there; `told` is what has been told of, and is brought up to date.
 */
function announce(params: {
  tree: TreeView;
  told: Set<ApprovalId>;
  onApproval: (approval: TreeApproval) => void;
  onGone: (id: ApprovalId) => void;
}): void {
  const { tree, told, onApproval, onGone } = params;
  const waiting = new Set(tree.approvals.map(({ request }) => request.id));

  for (const id of [...told]) {
    if (waiting.has(id)) continue;

    told.delete(id);
    onGone(id);
  }

  for (const { node, request } of tree.approvals) {
    if (told.has(request.id)) continue;

    told.add(request.id);
    onApproval({ node, asker: tree.nodes.find(({ id }) => id === node), request });
  }
}

/**
 * Answers a conversation's approvals through the tree channel: it follows the tree as one that
 * answers approvals (so a tool that asks waits for the user instead of being refused), and tells
 * `onApproval` of each approval once, when it first shows in the tree (one already waiting when it
 * connects included), with the node that asked as the tree has it. `onGone` is told when an approval
 * no longer waits, answered by this client or another, or given up: a UI takes its prompt down.
 * Answer through the route (`answerApproval`, with `answerWhileWaiting` to treat one answered
 * elsewhere as done).
 *
 * Resolves once the server has accepted the connection, which is when it counts: send the first
 * prompt after this. A dropped connection is resumed (`watchTree`), so an approval is told of once;
 * while it is down nobody listens, and a request made then is refused, not held. `ended` is
 * `watchTree`'s: it rejects when the tree channel fails (its conversation closed, or storing it
 * failed) or is refused, and with whatever `onApproval` or `onGone` throws, and each of those is
 * the end of the claim, so attach a handler to it. Replaces `watchApprovals`, which reads the
 * conversation's whole stream.
 */
export async function watchTreeApprovals(params: {
  client: ReturnType<typeof createClient>;
  id: ConversationId;
  onApproval: (approval: TreeApproval) => void;
  onGone?: (id: ApprovalId) => void;
  signal: AbortSignal;
}): Promise<{ ended: Promise<void> }> {
  const { client, id, onApproval, onGone = () => undefined, signal } = params;
  const told = new Set<ApprovalId>();
  const watch = await watchTree({
    client,
    id,
    approvals: true,
    signal,
    onChange: (tree) => {
      announce({ tree, told, onApproval, onGone });
    },
  });

  return { ended: watch.ended };
}

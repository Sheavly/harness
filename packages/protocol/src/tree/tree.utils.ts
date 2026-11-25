import type { ApprovalId } from '../approval/approval.types.js';
import { MAX_TREE_NODES, TREE_CHANNEL_NAME } from '../node/node.constants.js';
import type { NodeId } from '../node/node.types.js';
import { NODE_END_STATES } from '../status/status.constants.js';
import type { TreeChannelEntry, TreeSnapshot, TreeView } from './tree.types.js';

/** The part of a tree snapshot `isConsistentSnapshot` reads. */
type SnapshotFacts = {
  nodes: readonly { id: NodeId; parent?: NodeId | undefined }[];
  approvals: readonly { node: NodeId; request: { id: ApprovalId } }[];
};

/**
 * Whether the parents of `nodes` lead to a root and never in a circle: a node that is its own
 * parent, or a parent chain that returns to itself, has no root to draw it from. One walk per
 * node, each stopping at a node already known to reach a root, so it is linear.
 */
function reachesRoots(nodes: SnapshotFacts['nodes']): boolean {
  const parentOf = new Map(nodes.map((node) => [node.id, node.parent]));
  const rooted = new Set<NodeId>();

  for (const start of parentOf.keys()) {
    const walk = new Set<NodeId>();

    for (let id: NodeId | undefined = start; id !== undefined && !rooted.has(id);) {
      if (walk.has(id)) return false;

      walk.add(id);
      id = parentOf.get(id);
    }

    for (const id of walk) rooted.add(id);
  }

  return true;
}

/**
 * Whether a snapshot of the tree holds together: each node once, each node's parent among the
 * nodes (an ended node stays in it, so a child never points at one that is gone) and no parent
 * chain in a circle, each waiting approval once and asked by a node that is in it.
 */
export function isConsistentSnapshot(snapshot: SnapshotFacts): boolean {
  const { nodes, approvals } = snapshot;
  const ids = new Set(nodes.map((node) => node.id));

  if (ids.size !== nodes.length) return false;
  if (nodes.some((node) => node.parent !== undefined && !ids.has(node.parent))) return false;
  if (!reachesRoots(nodes)) return false;
  if (new Set(approvals.map(({ request }) => request.id)).size !== approvals.length) return false;

  return approvals.every(({ node }) => ids.has(node));
}

/** The tree before any entry: no node, and no approval waiting. */
export function emptyTree(): TreeView {
  return { nodes: [], approvals: [] };
}

/**
 * `nodes` kept to `MAX_TREE_NODES`, which a snapshot may hold: while there are more, the oldest
 * ended node that no node under it needs (no kept node has it as its parent) is dropped, so a child
 * never points at a node that is gone. A conversation that starts more sub-agents over its life than
 * that keeps the newest ones and everything that still runs. The nodes that are left over (all open,
 * or all parents) are kept: the node registry holds at most `MAX_TREE_NODES` at once, so those can
 * only be a log that was cut short.
 */
function boundedNodes(nodes: TreeView['nodes']): TreeView['nodes'] {
  const ended = new Set<string>(NODE_END_STATES);
  let kept = nodes;

  while (kept.length > MAX_TREE_NODES) {
    const parents = new Set(kept.map(({ parent }) => parent));
    const gone = kept.find(({ id, state }) => ended.has(state) && !parents.has(id));

    if (!gone) return kept;

    kept = kept.filter((node) => node !== gone);
  }

  return kept;
}

/** `nodes` with `node` in the place its id already has, or last when it is new. */
function withNode(params: { nodes: TreeView['nodes']; node: TreeView['nodes'][number] }) {
  const { nodes, node } = params;

  if (!nodes.some((each) => each.id === node.id)) return boundedNodes([...nodes, node]);

  return nodes.map((each) => (each.id === node.id ? node : each));
}

/**
 * The tree after `entry`: a node that opens, changes or closes is the node as the entry says (an
 * ended node stays, so a child never points at one that is gone, until the tree holds more than
 * `MAX_TREE_NODES`: then the oldest ended node nothing hangs from goes), an approval asked for waits,
 * and one answered or given up does not. Every other entry (the channel's own opening and closing, the
 * queue, a prompt, a storage failure, an extension's event) changes nothing in the tree, so a
 * client may fold the whole channel through this and ignore the entries it only shows.
 *
 * It is the one rule from entries to tree: a snapshot followed by the entries after its cursor
 * gives the same tree as every entry from the start. It is total (a node it has never seen is
 * added whatever the entry's type, an approval already waiting is replaced) so a log cut short at
 * its start still folds; whether the result holds together is `isConsistentSnapshot`.
 */
export function applyTreeEntry(params: { tree: TreeView; entry: TreeChannelEntry }): TreeView {
  const { tree, entry } = params;

  switch (entry.type) {
    case 'node_opened':
    case 'node_updated':
    case 'node_closed':
      return { ...tree, nodes: withNode({ nodes: tree.nodes, node: entry.node }) };
    case 'approval_requested':
      return {
        ...tree,
        approvals: [
          ...tree.approvals.filter(({ request }) => request.id !== entry.request.id),
          { node: entry.node, request: entry.request },
        ],
      };
    case 'approval_resolved':
    case 'approval_cancelled':
      return {
        ...tree,
        approvals: tree.approvals.filter(({ request }) => request.id !== entry.id),
      };
    case 'opened':
    case 'closed':
    case 'queue_changed':
    case 'prompt_started':
    case 'prompt_refused':
    case 'storage_failed':
    case 'extension_event':
      return tree;
  }
}

/** The snapshot of `tree` as it stands after the entry at `cursor`, written at `at`. */
export function treeSnapshotOf(params: {
  tree: TreeView;
  cursor: string;
  at: number;
}): TreeSnapshot {
  const { tree, cursor, at } = params;

  return {
    channel: TREE_CHANNEL_NAME,
    cursor,
    at,
    type: 'snapshot',
    nodes: tree.nodes,
    approvals: tree.approvals,
  };
}

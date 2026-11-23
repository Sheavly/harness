import type { ApprovalId } from '../approval/approval.types.js';
import type { NodeId } from '../node/node.types.js';

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

import type { NodeId } from '@sheavly/protocol/node/node.types';
import type { NodeRecord, NodeState } from './nodes.types.js';

/** Whether a node in `state` is still open: running, or idle between prompts (an agent's). */
export function isOpenState(state: NodeState): boolean {
  return state === 'running' || state === 'idle';
}

/**
 * Whether `caller` may see `node`: the node it started, one nobody started, or any node when the
 * caller names no one (the host's own reads). Another node's children read as unknown.
 */
export function isVisibleTo(params: { node: NodeRecord; caller: NodeId | undefined }): boolean {
  const { node, caller } = params;

  return caller === undefined || node.parent === undefined || node.parent === caller;
}

/** `id` and every node under it, from the registry's own map, `id` first. */
export function subtreeOf(params: {
  id: NodeId;
  nodes: ReadonlyMap<NodeId, NodeRecord>;
}): NodeRecord[] {
  const { id, nodes } = params;
  const root = nodes.get(id);

  if (!root) return [];

  const found = [root];

  // A node is always added after its parent, so one pass over the list finds every descendant.
  for (const node of nodes.values()) {
    if (node.parent !== undefined && found.some((member) => member.id === node.parent)) {
      found.push(node);
    }
  }

  return found;
}

/** How many nodes lie between `node` and the root, counting both: the main agent is 1. */
export function depthOf(params: {
  node: NodeRecord;
  nodes: ReadonlyMap<NodeId, NodeRecord>;
}): number {
  const { nodes } = params;
  let depth = 1;

  for (let parent = params.node.parent; parent !== undefined; parent = nodes.get(parent)?.parent) {
    depth += 1;
  }

  return depth;
}

import type { NodeId } from '@sheavly/protocol/node/node.types';

/** Why a node operation was refused. */
type NodeFailure =
  | 'unknown_node'
  | 'node_released'
  | 'node_running'
  | 'invalid_transition'
  | 'not_an_agent'
  | 'invalid_outcome'
  | 'inconsistent_node'
  | 'too_many_nodes'
  | 'cursor_out_of_range'
  | 'duplicate_channel';

/**
 * A node operation was refused: an unknown or released node, a move the node machine does not
 * allow, an agent-only move on another kind, an outcome that does not give the state, a release
 * of a node that is still open, a node past the bound the tree's snapshot holds
 * (`too_many_nodes`), a channel position the log cannot start at, or a second writer for a channel
 * of the conversation itself (`duplicate_channel`).
 */
export class NodeError extends Error {
  override name = 'NodeError';
  readonly reason: NodeFailure;
  /** The node the operation was about, when it was about one. */
  readonly nodeId?: NodeId;

  constructor(params: { reason: NodeFailure; nodeId?: NodeId; message: string }) {
    super(params.message);
    this.reason = params.reason;
    if (params.nodeId !== undefined) this.nodeId = params.nodeId;
  }
}

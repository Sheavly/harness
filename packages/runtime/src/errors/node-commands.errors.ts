import type { NodeId } from '@sheavly/protocol/node/node.types';

/** Why a command to a node was refused. */
type NodeCommandFailure =
  'unknown_node' | 'node_ended' | 'cannot_cancel' | 'cannot_message' | 'inbox_full';

/**
 * A command to a node was refused: the node is not in the conversation (`unknown_node`, including
 * one released), has ended (`node_ended`), is of a kind nothing can cancel (`cannot_cancel`), or is
 * not an agent that takes a message from the user (`cannot_message`), or an agent whose inbox is
 * full of messages it has not taken yet (`inbox_full`). Whether a node exists is
 * decided before whether it has ended, so a caller learns nothing about a node it cannot reach.
 */
export class NodeCommandError extends Error {
  override name = 'NodeCommandError';
  readonly reason: NodeCommandFailure;
  /** The node the command was for. */
  readonly nodeId: NodeId;

  constructor(params: { reason: NodeCommandFailure; nodeId: NodeId; message: string }) {
    const { reason, nodeId, message } = params;

    super(message);
    this.reason = reason;
    this.nodeId = nodeId;
  }
}

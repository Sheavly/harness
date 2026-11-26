import type { ApprovalRequest, ApprovalUpdate } from '@sheavly/protocol/approval/approval.types';
import type { NodeId } from '@sheavly/protocol/node/node.types';
import type { SessionId, SessionInfo } from '@sheavly/protocol/session/session.types';
import type { TreeView } from '@sheavly/protocol/tree/tree.types';

/**
 * An approval that waits, as the tree shows it: the request, and the node that asked. The node is
 * for display and never authorizes an answer, which is by the request's id. `asker` is that node as
 * the tree has it (its kind, title and state), and unset when the tree no longer holds it.
 */
export type TreeApproval = {
  node: NodeId;
  asker: TreeView['nodes'][number] | undefined;
  request: ApprovalRequest;
};

/** A sub-agent's session as the stream last showed it: its title, depth and parent. */
export type AgentSession = Extract<SessionInfo, { parentId: SessionId }>;

/** One approval update, with the session it is about and, for a sub-agent, who that is. */
export type HeardApproval = {
  update: ApprovalUpdate;
  /** The session whose tool asked: the stream entry's, so it is set even when `agent` is not. */
  sessionId: SessionId;
  /**
   * The sub-agent that asked, when the stream has shown it start. Unset for the main session; a
   * UI decides whether and how to render it, and can always fall back to `sessionId`.
   */
  agent?: AgentSession;
};

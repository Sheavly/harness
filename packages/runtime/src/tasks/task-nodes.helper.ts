import type { CallId } from '@sheavly/protocol/message/message.types';
import type { NodeId } from '@sheavly/protocol/node/node.types';
import type { SessionId } from '@sheavly/protocol/session/session.types';
import type { TaskKind } from '@sheavly/protocol/task/task.types';
import type { NodeRegistry } from '../nodes/node-registry.service.js';
import { NODE_KIND_OF_WORK, OUTCOME_OF_SETTLED, WORK_IS_SUB_AGENT } from './tasks.constants.js';
import type { Entry, NodeOwners } from './tasks.types.js';

/**
 * The node a task starts as. A sub-agent's work finds the agent node its session already is, the
 * one its parent's tool call started (`start_agent` starts the session, then the work, under one
 * call id), so one sub-agent is one node and its task is a view of it. Anything else gets a node of
 * its own, under the node of the session that owns it.
 */
export function openTaskNode(params: {
  owners: NodeOwners;
  sessionId: SessionId | undefined;
  callId: CallId | undefined;
  description: string;
  kind: TaskKind;
}): { nodeId: NodeId; sharesNode: boolean } {
  const { owners, sessionId, callId, description, kind } = params;
  const { nodes } = owners;
  const parent = sessionId === undefined ? undefined : owners.nodeIdOf(sessionId);
  const session =
    WORK_IS_SUB_AGENT[kind] && parent !== undefined && callId !== undefined
      ? nodes.children(parent).find((node) => node.spawnedBy === callId)
      : undefined;

  if (session) return { nodeId: session.id, sharesNode: true };

  const node = nodes.open({
    kind: NODE_KIND_OF_WORK[kind],
    parent,
    title: description,
    spawnedBy: callId,
  });

  return { nodeId: node.id, sharesNode: false };
}

/**
 * Ends the node of a task that has settled, in the state it settled in. A node that already ended
 * (a sub-agent's session ended first) keeps its first ending.
 */
export function endTaskNode(params: { nodes: NodeRegistry; entry: Entry }): void {
  const { nodes, entry } = params;
  const { status, kind } = entry.info;

  // A sub-agent's node goes with its session, which may have been released before the task ends.
  if (status === 'running' || nodes.isReleased(entry.nodeId)) return;

  if (WORK_IS_SUB_AGENT[kind]) {
    nodes.endAgent({ id: entry.nodeId, outcome: OUTCOME_OF_SETTLED[status] });
  } else {
    nodes.endWork({ id: entry.nodeId, state: status });
  }
}

/**
 * Forgets the node of a released task, which has ended. A sub-agent's node is its session's, and is
 * forgotten with the session.
 */
export function releaseTaskNode(params: { nodes: NodeRegistry; entry: Entry }): void {
  const { nodes, entry } = params;

  // The node may already be gone: releasing a session releases the nodes it started with it.
  if (!entry.sharesNode && !nodes.isReleased(entry.nodeId)) nodes.release(entry.nodeId);
}

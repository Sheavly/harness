import type { CallId } from '@sheavly/protocol/message/message.types';
import type { NodeId } from '@sheavly/protocol/node/node.types';
import type { SessionId } from '@sheavly/protocol/session/session.types';
import type { TaskInfo, TaskKind } from '@sheavly/protocol/task/task.types';
import type { NodeRegistry } from '../nodes/node-registry.service.js';
import { isOpenState } from '../nodes/nodes.utils.js';
import { NODE_KIND_OF_WORK, OUTCOME_OF_SETTLED, WORK_IS_SUB_AGENT } from './tasks.constants.js';
import type { Entry, NodeOwners } from './tasks.types.js';
import { newEntry } from './tasks.utils.js';

/**
 * The node a task starts as. A sub-agent's work is told the session it runs (`agentSessionId`,
 * which `start_agent` knows), and takes the agent node that session already is, so one sub-agent
 * is one node and its task is a view of it. The pairing is by that session and never by the tool
 * call id, which a provider may repeat and an extension may choose: it counts only when the node
 * is an open agent under the node of the session that owns the task, and no other task has taken
 * it. Anything else gets a node of its own, under the node of the session that owns it.
 * `entries` are the tasks the registry holds, to know which nodes are taken.
 */
function openTaskNode(params: {
  owners: NodeOwners;
  entries: Iterable<Entry>;
  sessionId: SessionId | undefined;
  agentSessionId: SessionId | undefined;
  callId: CallId | undefined;
  description: string;
  kind: TaskKind;
}): { nodeId: NodeId; sharesNode: boolean } {
  const { owners, entries, sessionId, agentSessionId, callId, description, kind } = params;
  const { nodes } = owners;
  const parent = sessionId === undefined ? undefined : owners.nodeIdOf(sessionId);
  const agent = WORK_IS_SUB_AGENT[kind] ? agentNodeOf({ owners, agentSessionId }) : undefined;
  const taken = new Set([...entries].map((entry) => entry.nodeId));

  if (
    agent &&
    parent !== undefined &&
    agent.parent === parent &&
    isOpenState(agent.state) &&
    !taken.has(agent.id)
  ) {
    return { nodeId: agent.id, sharesNode: true };
  }

  const node = nodes.open({
    kind: NODE_KIND_OF_WORK[kind],
    parent,
    title: description,
    spawnedBy: callId,
  });

  return { nodeId: node.id, sharesNode: false };
}

/**
 * The registry's record of a task that has just started, with the node it is (`openTaskNode`): the
 * `info` and `controller` are the task's own, and `owners` and `entries` are the registry's.
 */
export function newTaskEntry(params: {
  owners: NodeOwners;
  entries: Iterable<Entry>;
  info: TaskInfo;
  controller: AbortController;
  sessionId: SessionId | undefined;
  agentSessionId: SessionId | undefined;
}): Entry {
  const { owners, entries, info, controller, sessionId, agentSessionId } = params;
  const { callId, description, kind } = info;
  const node = openTaskNode({
    owners,
    entries,
    sessionId,
    agentSessionId,
    callId,
    description,
    kind,
  });

  // The session is in `info` as told even when its node was not taken (a registry with no shared
  // node owners has none to share): the loop cards and releases a sub-agent by it, and checks there
  // that the session is a child of the task's owner, so a wrong one costs nothing.
  return newEntry({ info, controller, sessionId, backgroundKind: kind, ...node });
}

/** The agent node of the session `agentSessionId`, when the work was told one and it is an agent. */
function agentNodeOf(params: { owners: NodeOwners; agentSessionId: SessionId | undefined }) {
  const { owners, agentSessionId } = params;
  const id = agentSessionId === undefined ? undefined : owners.nodeIdOf(agentSessionId);
  const node = id === undefined ? undefined : owners.nodes.get(id);

  return node?.kind === 'agent' ? node : undefined;
}

/**
 * Ends the node of a task that has settled, in the state it settled in. A sub-agent's node is its
 * session's and is left to it: the loop ends the session with how its last run ended, which
 * announces the change and cancels its approvals, as before nodes. A node released with its
 * session before the task settled is gone and is skipped.
 */
export function endTaskNode(params: { nodes: NodeRegistry; entry: Entry }): void {
  const { nodes, entry } = params;
  const { status, kind } = entry.info;

  if (status === 'running' || entry.sharesNode || nodes.isReleased(entry.nodeId)) return;

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

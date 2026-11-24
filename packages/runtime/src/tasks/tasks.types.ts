import type { OutputWriter } from '@sheavly/core/output/output.types';
import type { CallId } from '@sheavly/protocol/message/message.types';
import type { NodeId } from '@sheavly/protocol/node/node.types';
import type { SessionId } from '@sheavly/protocol/session/session.types';
import type { NodeRegistry } from '../nodes/node-registry.service.js';
import type { TaskId, TaskInfo, TaskKind, TaskUpdate } from '@sheavly/protocol/task/task.types';

/** What to run in the background. */
export type StartTask = {
  command: string;
  description: string;
  callId?: CallId;
  /** The session whose tool started it: its start and end go in that session's stream. */
  sessionId?: SessionId | undefined;
  /**
   * For a sub-agent's work: the session it runs. Its node is the task's node, so one sub-agent is
   * one node, and the loop finds the agent of a task by it instead of by the tool call id, which a
   * provider may repeat. Taken only when that session is an open sub-agent of `sessionId` that no
   * other task has taken; otherwise the task has a node of its own.
   */
  agentSessionId?: SessionId | undefined;
  /**
   * Where the complete output goes. The registry appends every chunk, shows the log's reference
   * and completeness on the task (`TaskInfo.outputLog`) while it runs, and closes it when the
   * task ends, so the output of a failed or cancelled task stays readable.
   */
  capture?: OutputWriter | undefined;
  /**
   * Finite work (`task`, `agent`) keeps its run alive until delivered; a `service` does not.
   * Defaults to task.
   */
  backgroundKind?: TaskKind;
  /**
   * Does the work. Must stop when `signal` aborts; reports output as it arrives. `output` is a
   * bounded preview. A task whose result is a document (a sub-agent's report) returns it as
   * `report` instead: it is kept whole, never shortened, and never mixed with progress output.
   */
  run: (params: {
    signal: AbortSignal;
    onOutput: (chunk: string) => void;
  }) => Promise<{ exitCode: number | null; report?: string }>;
};

/** One notice the registry holds until it is delivered: a single task or a group's members. */
export type Delivery = { ids: TaskId[]; reason?: string; delivered: boolean };

/**
 * What a task registry needs to put its tasks in the nodes of a conversation: the node registry
 * the sessions are in (`SessionRegistry.nodes`) and the node a session is. With none, a task
 * registry has a node registry of its own and its tasks have no parent node.
 */
export type NodeOwners = {
  nodes: NodeRegistry;
  nodeIdOf: (id: SessionId) => NodeId | undefined;
};

/** What the registry keeps for one task. */
export type Entry = {
  info: TaskInfo;
  /** The node this task is: its own, or the agent node of the session that runs the sub-agent. */
  nodeId: NodeId;
  /** Whether the node is the session's, so its release belongs to the session, not the task. */
  sharesNode: boolean;
  controller: AbortController;
  settled: Promise<void>;
  silent: boolean;
  sessionId?: SessionId | undefined;
  backgroundKind: TaskKind;
  /** Membership survives delivery until this entry is released. */
  group?: Delivery;
  /** The notice of an ungrouped task, set when it settles unsilenced and dropped when grouped. */
  delivery?: Delivery;
  /** Whole result, outside the bounded preview and task events. */
  report?: string | undefined;
};

/** One completion notice: a single task, or a whole group in requested ID order. */
export type TaskDelivery = { tasks: TaskInfo[]; reason?: string };

/** How a task ended: its exit code and report, or the error that stopped it. */
export type TaskResult = { exitCode?: number | null; error?: string; report?: string };

/**
 * A task update, with the session whose tool started it (unset for one started outside a run) and
 * the node the task is: its own, or the agent node of the session that runs the sub-agent. The
 * node is how something that follows the registry's nodes finds the task's command and output.
 */
export type TaskObserver = (params: {
  update: TaskUpdate;
  sessionId?: SessionId;
  nodeId: NodeId;
}) => void;

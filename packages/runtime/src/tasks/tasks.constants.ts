import type { TaskKind } from '@sheavly/protocol/task/task.types';
import type { NodeKind } from '../nodes/nodes.types.js';

/** Maximum task preview size, keeping first/last lines and bounded lines. */
export const MAX_TASK_OUTPUT_CHARS = 30_000;

/** Output shown by `formatTask` unless asked otherwise. */
export const DEFAULT_TASK_OUTPUT_CHARS = 4000;

/** The node kind each kind of background work is: a command, a sub-agent, a service. */
export const NODE_KIND_OF_WORK: Record<TaskKind, NodeKind> = {
  task: 'command',
  agent: 'agent',
  service: 'service',
};

/**
 * Whether a kind of work is a sub-agent, whose node is the agent node its session already is. A
 * table and not a comparison, so a new kind has to say which it is (`harness/no-adhoc-task-kind`).
 */
export const WORK_IS_SUB_AGENT: Record<TaskKind, boolean> = {
  task: false,
  agent: true,
  service: false,
};

/** How a sub-agent's last run ended, for each way its task settles: a cancel is an interrupt. */
export const OUTCOME_OF_SETTLED = {
  completed: 'completed',
  failed: 'failed',
  cancelled: 'interrupted',
} as const;

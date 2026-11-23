import { DEFAULT_TASK_OUTPUT_CHARS } from './tasks.constants.js';
import { outputReferenceLines } from '@sheavly/core/output/output.utils';
import type { CallId } from '@sheavly/protocol/message/message.types';
import type { NodeId } from '@sheavly/protocol/node/node.types';
import type { RunningTask } from '@sheavly/protocol/notice/notice.types';
import type { SessionId } from '@sheavly/protocol/session/session.types';
import type { TaskId, TaskInfo, TaskKind, TaskStatus } from '@sheavly/protocol/task/task.types';
import type { Entry } from './tasks.types.js';

/** Whether `id` is a canonical id (`t1`, `t42`, never `t0` or `t01`) below `nextId`. */
export function isIssued(params: { id: TaskId; nextId: number }): boolean {
  const digits = /^t([1-9]\d*)$/.exec(params.id)?.[1];

  return digits !== undefined && Number(digits) < params.nextId;
}

/**
 * What the model is told about an id the caller has no task for: one that never existed, one
 * another session owns, or one already reported and released. The three read alike, so an id
 * reveals nothing about another session's tasks.
 */
export function missingTaskMessage(id: TaskId): string {
  return `No task with id ${id}: it does not exist, or it was already reported and released`;
}

/** The snapshot of a task that has just started, before it has produced output. */
export function runningInfo(params: {
  id: TaskId;
  callId: CallId | undefined;
  command: string;
  description: string;
  kind: TaskKind;
  startedAt: number;
}): TaskInfo {
  const { id, callId, command, description, kind, startedAt } = params;

  return {
    id,
    ...(callId ? { callId } : {}),
    command,
    description,
    kind,
    status: 'running',
    startedAt,
    output: '',
  };
}

/** The registry's record of a task that has just started: running, not silenced, not notified. */
export function newEntry(params: {
  info: TaskInfo;
  controller: AbortController;
  sessionId: SessionId | undefined;
  backgroundKind: TaskKind;
  nodeId: NodeId;
  sharesNode: boolean;
}): Entry {
  return { ...params, settled: Promise.resolve(), silent: false };
}

/**
 * The status a task settles with. A run that reported success finished, even if a cancel aborted
 * its signal before the settle ran: the registry cannot see whether the resolve or the abort came
 * first, only the result. Any other end after an abort is a cancel. A run that ignores the abort
 * and then succeeds is recorded as completed.
 */
export function settledStatus(params: { status: TaskStatus; aborted: boolean }): TaskStatus {
  const { status, aborted } = params;

  if (status === 'completed') return status;

  return aborted ? 'cancelled' : status;
}

/**
 * A running task's metadata-only snapshot. `group` is the task's group's first requested ID, given
 * only when the caller may see the group; otherwise the reason falls back to the description.
 */
export function runningTaskOf(params: { info: TaskInfo; group: TaskId | undefined }): RunningTask {
  const { info, group } = params;

  return {
    id: info.id,
    title: info.description,
    reason: group ? (info.reason ?? info.description) : info.description,
    startedAt: info.startedAt,
    ...(group && { group }),
  };
}

/**
 * One readable block for the model: header line, command, then the task's result. A task that
 * returned a `report` shows it whole and nothing else of its output: the output is progress, and
 * the report is the result, which is never cut. Otherwise it is the output, its tail only when
 * longer than `outputChars`. `now` is the time a task still running is measured to; a finished
 * one ends at its own `endedAt`.
 */
export function formatTask(params: {
  task: TaskInfo;
  now: number;
  outputChars?: number;
  report?: string | undefined;
}): string {
  const { task, now, outputChars = DEFAULT_TASK_OUTPUT_CHARS, report } = params;
  const elapsed = ((task.endedAt ?? now) - task.startedAt) / 1000;
  const parts: string[] = [task.status];

  if (task.exitCode !== undefined) parts.push(`exit code ${task.exitCode ?? 'unknown'}`);
  parts.push(`${elapsed.toFixed(1)}s`);

  const preview =
    task.output.length > outputChars ? `[…]\n${task.output.slice(-outputChars)}` : task.output;
  const output = report ?? preview;
  // A task's own preview is cut to `outputChars`, so the reference is compared with what is shown.
  const reference =
    report === undefined ? outputReferenceLines({ log: task.outputLog, shown: preview }) : [];

  return [
    `[task ${task.id} · ${parts.join(' · ')}] $ ${task.command}`,
    task.error,
    output.trimEnd(),
    ...reference,
  ]
    .filter(Boolean)
    .join('\n');
}

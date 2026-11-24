import { DEFAULT_TASK_OUTPUT_CHARS, WORK_IS_SUB_AGENT } from './tasks.constants.js';
import { outputReferenceLines } from '@sheavly/core/output/output.utils';
import { escapedLine } from '@sheavly/core/text/text.utils';
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
  /** The session the work runs. Kept only on sub-agent work: a command that named one runs none. */
  agentSessionId: SessionId | undefined;
  command: string;
  description: string;
  kind: TaskKind;
  startedAt: number;
}): TaskInfo {
  const { id, callId, agentSessionId, command, description, kind, startedAt } = params;

  return {
    id,
    ...(callId ? { callId } : {}),
    ...(agentSessionId !== undefined && WORK_IS_SUB_AGENT[kind] && { agentSessionId }),
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

/** The tail of `output` that fits `chars`, marked as cut; nothing at all when no characters are asked for. */
function previewOf(params: { output: string; chars: number }): string {
  const { output, chars } = params;

  // Not `chars <= 0`: a NaN is no count either, and must not read as "the whole output".
  if (!(chars > 0)) return '';

  return output.length > chars ? `[…]\n${output.slice(-chars)}` : output;
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

  const preview = previewOf({ output: task.output, chars: outputChars });
  const output = report ?? preview;
  // A task's own preview is cut to `outputChars`, so the reference is compared with what is shown.
  // A list asks for none (`outputChars` 0) and gets headers only, so it carries no reference.
  const reference =
    report === undefined && outputChars > 0
      ? outputReferenceLines({ log: task.outputLog, shown: preview })
      : [];

  // The command is a line anyone who started the task wrote (an extension names its own work), and
  // an error can quote one: neither may close a tag or start a line of its own.
  return [
    `[task ${task.id} · ${parts.join(' · ')}] $ ${escapedLine(task.command)}`,
    task.error === undefined ? undefined : escapedLine(task.error),
    output.trimEnd(),
    ...reference,
  ]
    .filter(Boolean)
    .join('\n');
}

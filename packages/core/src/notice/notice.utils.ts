import type {
  HarnessNotice,
  RunningTask,
  RunningTasksNotice,
  TaskCompletionContext,
} from '@sheavly/protocol/notice/notice.types';
import { outputReferenceLines } from '../output/output.utils.js';
import { attributeValue, escapedLine, escapeTags, fenceDashes } from '../text/text.utils.js';
import {
  renderAgentReport,
  renderCompletionContext,
  renderCompletionMetrics,
  renderContextUsage,
  renderExtensionNotice,
  renderExtensionNoticeEnvelope,
  renderHookFailed,
  renderNoticeEnvelope,
  renderOutputContinuation,
  renderRunningTask,
  renderRunningTasks,
  renderTaskFinished,
  renderTasksFinished,
} from './notice.prompt.js';

const count = new Intl.NumberFormat('en-US');

/** Formats trusted harness data with its origin and handling policy, never as a user request. */
export function formatHarnessNotice(notice: HarnessNotice): string {
  if (notice.kind === 'extension-notice') {
    return renderExtensionNoticeEnvelope({
      extension: attributeValue(notice.extension),
      body: formatExtensionNotice(notice),
    });
  }

  return renderNoticeEnvelope({ kind: notice.kind, body: prepareNoticeBody(notice) });
}

function prepareNoticeBody(notice: Exclude<HarnessNotice, { kind: 'extension-notice' }>): string {
  switch (notice.kind) {
    case 'running-tasks':
      return formatRunningTasks(notice);
    case 'context-usage':
      return contextDescription(notice.context);
    case 'output-continuation':
      return renderOutputContinuation({ connection: notice.reason === 'connection' });
    case 'agent-report':
      return formatAgentReport(notice);
    case 'task-finished':
      return formatTaskFinished(notice);
    case 'hook-failed':
      return formatHookFailed(notice);
    case 'tasks-finished':
      return formatTasksFinished(notice);
  }
}

/** Live metadata stays outside agent-authored reason fences; no command or output is included. */
function formatRunningTasks(notice: RunningTasksNotice): string {
  return renderRunningTasks({
    total: String(notice.total),
    omitted: String(notice.omitted),
    tasks: notice.tasks.map(formatRunningTask),
  });
}

function formatRunningTask(task: RunningTask): string {
  const reason = escapeTags(task.reason);

  return renderRunningTask({
    id: line(task.id),
    title: line(task.title),
    group: task.group === undefined ? undefined : line(task.group),
    startedAt: String(task.startedAt),
    reason,
    fence: fenceDashes(reason),
  });
}

/**
 * A sub-agent's report, whole, between fixed lines. Its text is model-written and may carry
 * injected instructions, so only its angle brackets are swapped (it cannot close the envelope) and
 * the rest is left as the sub-agent wrote it.
 */
function formatAgentReport(notice: Extract<HarnessNotice, { kind: 'agent-report' }>): string {
  const { agent, taskId, outcome, report } = notice;
  const body = escapeTags(report);

  return renderAgentReport({
    title: line(agent.title),
    id: line(agent.id),
    taskId: taskId === undefined ? undefined : line(taskId),
    outcome: line(outcome),
    status: agent.status ? line(agent.status) : undefined,
    body,
    fence: fenceDashes(body),
    context: formatCompletionContext(notice.context),
  });
}

/** A header field as one escaped line: the harness made most of them, but history is a file. */
const line = escapedLine;

/** A finished task: how it ended, and its bounded output preview as data. */
function formatTaskFinished(notice: Extract<HarnessNotice, { kind: 'task-finished' }>): string {
  const { task } = notice;
  const elapsed = ((task.endedAt ?? task.startedAt) - task.startedAt) / 1000;
  // The error and the output are both what the command printed: data, fenced together.
  const body = escapeTags([task.error, task.output.trimEnd()].filter(Boolean).join('\n'));

  return renderTaskFinished({
    id: line(task.id),
    status: line(task.status),
    exitCode: task.exitCode === undefined ? undefined : String(task.exitCode ?? 'unknown'),
    elapsed: Math.max(0, elapsed).toFixed(1),
    command: line(task.command),
    body,
    fence: fenceDashes(body),
    outputReference: outputReferenceLines({ log: task.outputLog, shown: task.output }),
    context: formatCompletionContext(notice.context),
  });
}

/**
 * An extension's text is third-party and written for the model, so it is escaped and fenced like a
 * report. Only `text` and the topic are used: `data` is for UIs and never reaches the model.
 */
function formatExtensionNotice(
  notice: Extract<HarnessNotice, { kind: 'extension-notice' }>,
): string {
  const text = escapeTags(notice.text);

  return renderExtensionNotice({ topic: line(notice.topic), text, fence: fenceDashes(text) });
}

/** The hook's error is code-written text: angle brackets swapped and fenced as data. */
function formatHookFailed(notice: Extract<HarnessNotice, { kind: 'hook-failed' }>): string {
  const error = escapeTags(notice.error);

  return renderHookFailed({
    hook: line(notice.hook),
    handler: line(notice.handler),
    repeats: notice.repeats === undefined ? undefined : String(notice.repeats),
    error,
    fence: fenceDashes(error),
  });
}

/** Reuses individual bodies without nesting trusted envelopes around agent-authored data. */
function formatTasksFinished(notice: Extract<HarnessNotice, { kind: 'tasks-finished' }>): string {
  const reason = escapeTags(notice.reason);
  const fence = fenceDashes(reason);
  const bodies = notice.notices.map((individual) => {
    if (individual.kind === 'agent-report') return formatAgentReport(individual);

    return formatTaskFinished(individual);
  });

  return renderTasksFinished({
    reason,
    fence,
    metrics: formatCompletionMetrics(notice.context),
    bodies,
  });
}

/** Keep the calling agent's reason fenced separately from trusted completion measurements. */
function formatCompletionContext(context: TaskCompletionContext): string[] {
  const reason = escapeTags(context.reason);
  const fence = fenceDashes(reason);

  return renderCompletionContext({ metrics: formatCompletionMetrics(context), reason, fence });
}

function formatCompletionMetrics(context: TaskCompletionContext): string[] {
  return renderCompletionMetrics({
    startedAt: String(context.startedAt),
    durationMs: String(context.durationMs),
    userMessagesSinceStart: String(context.userMessagesSinceStart),
    callId: context.callId === undefined ? undefined : line(context.callId),
  });
}

function contextDescription(
  context: Extract<HarnessNotice, { kind: 'context-usage' }>['context'],
): string {
  const { window, used } = context;

  return renderContextUsage({
    window: window === undefined ? undefined : count.format(window),
    used: used === undefined ? undefined : count.format(used),
    percent:
      window === undefined || used === undefined
        ? undefined
        : String(Math.round((used / window) * 100)),
  });
}

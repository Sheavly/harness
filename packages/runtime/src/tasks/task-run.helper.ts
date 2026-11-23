import type { OutputWriter } from '@sheavly/core/output/output.types';
import type { TaskInfo, TaskStatus } from '@sheavly/protocol/task/task.types';
import { OutputBuffer } from '../output/output.service.js';
import { closeTaskCapture } from './capture.helper.js';
import { MAX_TASK_OUTPUT_CHARS } from './tasks.constants.js';
import type { StartTask, TaskResult } from './tasks.types.js';

/**
 * Runs a task's work and reports how it ended to `settle`. Output goes to the task's bounded
 * preview (`info.output`) and, with a `capture`, to the stored log, whose reference the task shows
 * while it runs. The returned promise resolves once `settle` has been called, and never rejects:
 * a run that throws settles the task as failed with the error's message.
 */
export function runTask(params: {
  info: TaskInfo;
  signal: AbortSignal;
  capture: OutputWriter | undefined;
  run: StartTask['run'];
  settle: (ended: { status: TaskStatus; result: TaskResult }) => void;
}): Promise<void> {
  const { info, signal, capture, run, settle } = params;
  const output = new OutputBuffer({ maxChars: MAX_TASK_OUTPUT_CHARS });
  const onOutput = (chunk: string) => {
    output.push(chunk);
    info.output = output.text;
    capture?.append(chunk);
    if (capture) info.outputLog = capture.log;
  };

  if (capture) info.outputLog = capture.log;

  // The log is closed before the task settles, so its final state is what a notice reports. That
  // waits for queued writes, which are bounded in bytes, so a stalled disk delays settling.
  const closeCapture = async () => {
    if (capture) info.outputLog = await closeTaskCapture(capture);
  };

  return run({ signal, onOutput }).then(
    async ({ exitCode, report }) => {
      await closeCapture();
      settle({
        status: exitCode === 0 ? 'completed' : 'failed',
        result: { exitCode, ...(report !== undefined && { report }) },
      });
    },
    async (caughtError: unknown) => {
      const error = caughtError instanceof Error ? caughtError.message : String(caughtError);

      await closeCapture();
      settle({ status: 'failed', result: { error } });
    },
  );
}

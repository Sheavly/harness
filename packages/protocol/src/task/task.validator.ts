import { z } from 'zod';
import { callIdSchema } from '../message/message.validator.js';
import { outputLogSchema } from '../output/output.validator.js';
import { sessionIdSchema } from '../session/session.validator.js';
import { TASK_STATUSES } from '../status/status.constants.js';
import { timestampSchema } from '../time/time.validator.js';

export const taskStatusSchema = z.enum(TASK_STATUSES);

/**
 * What a UI calls a piece of background work: a command (`task`), a sub-agent (`agent`), or a
 * service that is never awaited and may outlive the run. Naming, not policy: a sub-agent is
 * finite work like a task.
 */
export const taskKindSchema = z.enum(['task', 'agent', 'service']);

/**
 * A background task's id, unique within its registry. Branded, so it can't be passed where a
 * session's, tool call's or approval's id goes; it is still a plain string on the wire.
 */
export const taskIdSchema = z.string().brand<'TaskId'>();

/** A snapshot of a background task. Registry methods always return copies, never live objects. */
export const taskInfoSchema = z.object({
  id: taskIdSchema,
  /** The tool call that started it, so the loop can tie the launch to its call. */
  callId: callIdSchema.exactOptional(),
  /**
   * For a sub-agent (`kind: 'agent'`): the session it runs, which is the stable key to the agent
   * the task is about. A tool call id is a provider's and repeats, so nothing joins a task to its
   * agent by it. A task that runs no session has none.
   */
  agentSessionId: sessionIdSchema.exactOptional(),
  command: z.string(),
  description: z.string(),
  kind: taskKindSchema,
  /** Explicit await_tasks reason, absent until the task joins a delivery group. */
  reason: z.string().exactOptional(),
  status: taskStatusSchema,
  startedAt: timestampSchema,
  endedAt: timestampSchema.exactOptional(),
  exitCode: z.number().int().nullable().exactOptional(),
  /** Combined stdout/stderr so far (the most recent part, if it was long). */
  output: z.string(),
  /** Where the complete output is kept, when it is captured: `output` stays a bounded preview. */
  outputLog: outputLogSchema.exactOptional(),
  error: z.string().exactOptional(),
});

/**
 * A background task starting or ending, as a UI follows it: its snapshot then (`task_ended`
 * carries its status, exit code and the end of its output).
 */
export const taskUpdateSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('task_started'), task: taskInfoSchema }),
  z.object({ type: z.literal('task_ended'), task: taskInfoSchema }),
]);

import { z } from 'zod';
import { approvalUpdateSchema } from '../approval/approval.validator.js';
import { entryEventSchema } from '../event/event.validator.js';
import { sessionIdSchema, sessionUpdateSchema } from '../session/session.validator.js';
import { taskUpdateSchema } from '../task/task.validator.js';
import { timestampSchema } from '../time/time.validator.js';
import { messageIdSchema } from '../message/message.validator.js';
import { queueUpdateSchema } from '../queue/queue.validator.js';

/**
 * One entry of a session tree's combined stream: every session's loop events (sub-agents
 * included), every session update, every approval and every background task's start and end, in
 * one causal order. `seq` counts the whole tree, 0, 1,
 * 2, ... with no gaps; `sessionId` names the session the entry is about; `at` is when the entry
 * was added to the stream. An `event` keeps its own
 * session's `seq` too, so a UI can also follow one session alone. Its `done` carries no
 * `messages`: the history is read on its own, so the stream (kept for replay) stays small.
 */
export const streamEntrySchema = z.intersection(
  z.object({
    seq: z.number().int().nonnegative(),
    sessionId: sessionIdSchema,
    /** The originating user message, not whichever prompt the parent is processing now. */
    messageId: messageIdSchema.exactOptional(),
    at: timestampSchema,
  }),
  z.discriminatedUnion('kind', [
    z.object({ kind: z.literal('event'), event: entryEventSchema }),
    z.object({ kind: z.literal('update'), update: sessionUpdateSchema }),
    /**
     * An approval a session's tool asked for, answered or gave up on, in order with its events: a
     * client replaying the stream sees every `approval_requested` still without its answer.
     */
    z.object({ kind: z.literal('approval'), update: approvalUpdateSchema }),
    /**
     * A background task starting or ending, under the session whose tool started it: a UI shows
     * what still runs (a run waiting for its tasks, a task panel) without asking.
     */
    z.object({ kind: z.literal('task'), update: taskUpdateSchema }),
    /**
     * The conversation's queue changed, under its main session: a line joined it, started as the
     * next prompt (before that run's entries) or could not start.
     */
    z.object({ kind: z.literal('queue'), update: queueUpdateSchema }),
  ]),
);

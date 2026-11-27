import { callIdSchema } from '@sheavly/protocol/message/message.validator';
import { sessionIdSchema } from '@sheavly/protocol/session/session.validator';
import type { StreamEntry } from '@sheavly/protocol/stream/stream.types';
import { taskIdSchema } from '@sheavly/protocol/task/task.validator';

export const MAIN = sessionIdSchema.parse('main');
export const HELPER = sessionIdSchema.parse('helper');

const mainRef = { id: MAIN, rootId: MAIN, depth: 1 } as const;
const call = { id: callIdSchema.parse('call-1'), name: 'run_command', input: { command: 'ls' } };
const task = {
  id: taskIdSchema.parse('task-1'),
  command: 'npm test',
  description: 'tests',
  kind: 'task',
  startedAt: 5,
  output: '',
} as const;

/** The entries as a run writes them, still without `seq` and `at`. */
type Bare = StreamEntry extends infer E
  ? E extends unknown
    ? Omit<E, 'seq' | 'at'>
    : never
  : never;

const bare: Bare[] = [
  {
    kind: 'update',
    sessionId: MAIN,
    update: {
      type: 'session_started',
      session: { ...mainRef, title: 'Fixture', state: 'running', startedAt: 1 },
    },
  },
  {
    kind: 'update',
    sessionId: HELPER,
    update: {
      type: 'session_started',
      session: {
        id: HELPER,
        parentId: MAIN,
        startedByCall: call.id,
        rootId: MAIN,
        depth: 2,
        title: 'Look around',
        state: 'running',
        startedAt: 2,
      },
    },
  },
  { kind: 'event', sessionId: MAIN, event: { seq: 0, type: 'text_delta', text: 'Looking.\n' } },
  {
    kind: 'event',
    sessionId: MAIN,
    event: { seq: 1, type: 'tool_call_started', call, description: 'list files' },
  },
  {
    kind: 'task',
    sessionId: MAIN,
    update: { type: 'task_started', task: { ...task, status: 'running' } },
  },
  {
    kind: 'event',
    sessionId: MAIN,
    event: {
      seq: 2,
      type: 'tool_result',
      call,
      description: 'list files',
      message: { role: 'tool', toolCallId: call.id, content: 'a.ts', isError: false },
      durationMs: 300,
    },
  },
  {
    kind: 'task',
    sessionId: MAIN,
    update: {
      type: 'task_ended',
      task: { ...task, status: 'completed', exitCode: 0, endedAt: 9 },
    },
  },
  {
    kind: 'update',
    sessionId: HELPER,
    update: {
      type: 'session_ended',
      session: {
        id: HELPER,
        parentId: MAIN,
        startedByCall: call.id,
        rootId: MAIN,
        depth: 2,
        title: 'Look around',
        state: 'completed',
        lastOutcome: 'completed',
        startedAt: 2,
        endedAt: 8,
      },
    },
  },
  {
    kind: 'event',
    sessionId: MAIN,
    event: { seq: 3, type: 'done', reason: 'completed', session: mainRef },
  },
];

/** Test-only: a finished run of the main session, with a sub-agent and a task; `seq` has no gaps. */
export function fixtureEntries(): StreamEntry[] {
  return bare.map((entry, seq) => ({ ...entry, seq, at: 10 + seq }));
}

/**
 * Test-only: the lines an older version wrote after the fixture's entries, as raw objects (today's
 * types refuse both): a session snapshot with `mode` for `effort`, and a queue line that started
 * before a queued line had a message id.
 */
export function oldFormEntries(): { seq: number; [key: string]: unknown }[] {
  const next = fixtureEntries().length;

  return [
    {
      seq: next,
      at: 90,
      sessionId: MAIN,
      kind: 'update',
      update: {
        type: 'session_idle',
        session: {
          ...mainRef,
          title: 'Fixture',
          state: 'idle',
          lastOutcome: 'completed',
          startedAt: 1,
          modelId: '4b1f9a52-3c5e-4a77-9d64-0e2b7f1c8a30',
          mode: 'high',
        },
      },
    },
    {
      seq: next + 1,
      at: 91,
      sessionId: MAIN,
      kind: 'queue',
      update: { type: 'prompt_started', text: 'go on', queued: [] },
    },
  ];
}

/** Test-only: entries as a conversation's `stream.jsonl`, every line ended by a newline. */
export function asJsonl(entries: readonly { seq: number }[]): string {
  return entries.map((entry) => `${JSON.stringify(entry)}\n`).join('');
}

/** Test-only: entries as the backend's server-sent events, with a head frame and a heartbeat. */
export function asSse(entries: readonly { seq: number }[]): string {
  const frames = entries.map(
    (entry) => `event: entry\nid: ${String(entry.seq)}\ndata: ${JSON.stringify(entry)}\n\n`,
  );

  return `id: 0\n\n: heartbeat\n\n${frames.join('')}`;
}

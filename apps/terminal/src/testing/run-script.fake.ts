import { entryEventSchema } from '@sheavly/protocol/event/event.validator';
import { nodeIdSchema } from '@sheavly/protocol/node/node.validator';
import { sessionIdSchema, sessionUpdateSchema } from '@sheavly/protocol/session/session.validator';
import type { SessionUpdate } from '@sheavly/protocol/session/session.types';
import type { StreamEntry } from '@sheavly/protocol/stream/stream.types';
import type { ChatItem } from '../client/transcript.types.js';

const MAIN = sessionIdSchema.parse('main');

const call = (id: string, name: string, input: object = {}) => ({ id, name, input });
const finished = (id: string, content: string, extra: object = {}) => ({
  type: 'tool_result',
  call: call(id, 'run_command'),
  description: `Step ${id}`,
  message: { role: 'tool', toolCallId: id, content, isError: false },
  durationMs: 300,
  ...extra,
});

const taskAt = (status: 'running' | 'completed') => ({
  id: 't1',
  callId: 'c3',
  command: 'helper',
  description: 'a helper',
  kind: 'agent',
  status,
  startedAt: 1,
  ...(status === 'completed' && { endedAt: 2, exitCode: 0 }),
  output: '',
});

/** The run, as the main agent's events say it: parsed (by `numbered`), so a wrong shape fails. */
const EVENTS = [
  { type: 'text_delta', text: 'Let me look.\n' },
  { type: 'reasoning', item: { source: 'test', data: 1 } },
  { type: 'reasoning_activity', active: true },
  {
    type: 'tool_call_started',
    call: call('c1', 'run_command', { command: 'npm test' }),
    description: 'Run the tests',
  },
  {
    type: 'tool_call_started',
    call: call('c2', 'edit_file'),
    description: 'Edit a.ts',
  },
  {
    type: 'tool_batch',
    calls: [
      { call: call('c1', 'run_command'), description: 'Run the tests' },
      { call: call('c2', 'edit_file'), description: 'Edit a.ts' },
    ],
  },
  finished('c1', 'ok'),
  finished('c2', 'Edited a.ts', {
    artifacts: [{ kind: 'file_change', path: 'a.ts', before: 'a\n', after: 'b\n' }],
  }),
  {
    type: 'tool_call_started',
    call: call('c3', 'start_agent'),
    description: 'Start a helper',
  },
  {
    type: 'tool_batch',
    calls: [{ call: call('c3', 'start_agent'), description: 'Start a helper' }],
  },
  {
    type: 'task_running',
    call: call('c3', 'start_agent'),
    description: 'Start a helper',
    task: taskAt('running'),
    message: { role: 'tool', toolCallId: 'c3', content: 'started', isError: false },
    durationMs: 5,
  },
  { type: 'text_delta', text: 'Working on it.\n' },
  { type: 'task_completed', task: taskAt('completed') },
  { type: 'message_received', message: { from: 'user', content: 'also this', sentAt: 1 } },
  { type: 'context_added', hook: 'notes', content: 'x'.repeat(12) },
  { type: 'model_input_changed', hook: 'trim', turn: 1, added: 1, removed: 2, edited: 3 },
  { type: 'hook_failed', hook: 'lint', handler: 'h.ts', error: 'boom' },
  { type: 'storage_failed', error: 'disk full' },
  {
    type: 'extension_event',
    extension: 'acme',
    kind: 'acme.deploy',
    version: 1,
    data: {},
    text: 'Deploy finished',
  },
  { type: 'model_connection', connection: { state: 'restored' } },
  { type: 'turn_end', turn: 1, stopReason: 'end_turn' },
  {
    type: 'run_failed',
    error: 'model fell over',
    session: { id: 'main', rootId: 'main', depth: 1 },
  },
  { type: 'text_delta', text: 'Back again.\n' },
  { type: 'done', reason: 'completed', session: { id: 'main', rootId: 'main', depth: 1 } },
];

/** Where, among the events (by the index of the one before), each change of the sub-agent comes. */
const CARDS = [
  { after: 10, change: 'started' as const },
  { after: 10, change: 'status' as const },
  { after: 12, change: 'ended' as const },
];

const WORKER = {
  title: 'Helper',
  parent: 'main',
  startedByCall: 'c3',
  startedAt: 1,
} as const;

/** The sub-agent as the stream's session says it at `change`. */
function sessionAt(change: 'started' | 'status' | 'ended'): SessionUpdate {
  const base = {
    ...WORKER,
    id: 'worker',
    parentId: 'main',
    rootId: 'main',
    depth: 2,
  };

  if (change === 'ended') {
    return sessionUpdateSchema.parse({
      type: 'session_ended',
      session: { ...base, state: 'max_turns', lastOutcome: 'max_turns', endedAt: 5 },
    });
  }

  return sessionUpdateSchema.parse({
    type: change === 'started' ? 'session_started' : 'session_status',
    session: { ...base, state: 'running', ...(change === 'status' && { status: 'reading' }) },
  });
}

/** The same sub-agent as the tree's card says it at `change`. */
function cardAt(change: 'started' | 'status' | 'ended'): ChatItem {
  const agent = {
    id: nodeIdSchema.parse('worker'),
    title: 'Helper',
    depth: 2,
    parent: nodeIdSchema.parse('main'),
    root: nodeIdSchema.parse('main'),
  };

  if (change === 'ended') {
    return { type: 'agent', change, agent: { ...agent, state: 'failed', outcome: 'max_turns' } };
  }

  return {
    type: 'agent',
    change,
    agent: { ...agent, state: 'running', ...(change === 'status' && { status: 'reading' }) },
  };
}

/** The item a main-agent event is drawn from: the tree's notices have an item of their own. */
function itemOfEvent(event: ReturnType<typeof entryEventSchema.parse>): ChatItem {
  if (event.type === 'storage_failed') return { type: 'storage_failed', error: event.error };

  if (event.type === 'extension_event') {
    return {
      type: 'extension_event',
      extension: event.extension,
      kind: event.kind,
      version: event.version,
      data: event.data,
      text: event.text,
    };
  }

  return { type: 'event', event };
}

/** The events of the script, numbered as the backend numbers them. */
const numbered = () => EVENTS.map((event, seq) => entryEventSchema.parse({ ...event, seq }));

/**
 * Test-only: one scripted run as the combined stream tells it: the main session's events and
 * the sub-agent's session updates, in order. The workbook, the demo and replay draw it so.
 */
export function scriptEntries(): StreamEntry[] {
  return numbered().flatMap((event, index) => {
    const entry: StreamEntry = { seq: index, at: 0, sessionId: MAIN, kind: 'event', event };
    const updates: StreamEntry[] = CARDS.filter(({ after }) => after === index).map(
      ({ change }) => ({
        seq: 100 + index,
        at: 0,
        sessionId: MAIN,
        kind: 'update' as const,
        update: sessionAt(change),
      }),
    );

    return [entry, ...updates];
  });
}

/**
 * Test-only: the same scripted run as the transcript feed tells it: the main agent's events, the
 * tree's notices and the sub-agent's cards. A chat draws it so.
 */
export function scriptItems(): ChatItem[] {
  return numbered().flatMap((event, index) => [
    itemOfEvent(event),
    ...CARDS.filter(({ after }) => after === index).map(({ change }) => cardAt(change)),
  ]);
}

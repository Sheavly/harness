import type { EntryEvent } from '@sheavly/protocol/event/event.types';
import { entryEventSchema } from '@sheavly/protocol/event/event.validator';
import { callIdSchema, messageIdSchema } from '@sheavly/protocol/message/message.validator';
import type { MessageId } from '@sheavly/protocol/message/message.types';
import { nodeIdSchema } from '@sheavly/protocol/node/node.validator';
import type { RunOutcome } from '@sheavly/protocol/session/session.types';
import { sessionIdSchema } from '@sheavly/protocol/session/session.validator';
import type { ChatItem, SubAgentCard } from '../../client/transcript.types.js';

const MAIN_SESSION = sessionIdSchema.parse('main');
const MAIN = { id: MAIN_SESSION, rootId: MAIN_SESSION, depth: 1 } as const;

/** Test-only: the message id numbered `n`, as a backend would have made one. */
export const messageIdOf = (n: number): MessageId =>
  messageIdSchema.parse(`00000000-0000-4000-8000-${n.toString(16).padStart(12, '0')}`);

/** What a card says about a sub-agent: its node, and what differs from a plain depth-2 one. */
type CardParams = {
  node?: string;
  title?: string;
  depth?: number;
  spawnedBy?: string;
  status?: string;
  state?: SubAgentCard['state'];
  outcome?: RunOutcome;
};

/**
 * Test-only: what the transcript feed hands a chat, built the way the backend numbers its events:
 * each event the main agent makes takes the next `seq`.
 */
export function feedItems() {
  let seq = 0;
  const event = (made: EntryEvent): ChatItem => {
    const at = seq;

    seq += 1;

    return { type: 'event', event: { ...made, seq: at } };
  };
  const call = (id: string, name = 'run_command') => ({
    id: callIdSchema.parse(id),
    name,
    input: {},
  });

  return {
    event,
    /** A run starts: a prompt's, or a wake's (the backend's own). */
    runStarted: (params: {
      cause: 'prompt' | 'wake';
      messageId: MessageId;
      text?: string;
    }): ChatItem => ({
      type: 'run_started',
      cause: params.cause,
      messageId: params.messageId,
      ...(params.text !== undefined && { text: params.text }),
    }),
    /** The run of the line `text`, which the backend started as message `messageId`. */
    prompt: (params: { messageId: MessageId; text: string }): ChatItem => ({
      type: 'run_started',
      cause: 'prompt',
      messageId: params.messageId,
      text: params.text,
    }),
    wake: (messageId: MessageId): ChatItem => ({ type: 'run_started', cause: 'wake', messageId }),
    started: (params: { text: string; messageId: MessageId; queued?: string[] }): ChatItem => ({
      type: 'prompt_started',
      text: params.text,
      messageId: params.messageId,
      queued: params.queued ?? [],
    }),
    changed: (queued: string[], dropped?: MessageId[]): ChatItem => ({
      type: 'queue_changed',
      queued,
      ...(dropped && { dropped }),
    }),
    refused: (params: {
      text: string;
      error: string;
      messageId: MessageId;
      queued?: string[];
    }): ChatItem => ({
      type: 'prompt_refused',
      text: params.text,
      error: params.error,
      messageId: params.messageId,
      queued: params.queued ?? [],
    }),
    text: (value: string): ChatItem => event({ seq: 0, type: 'text_delta', text: value }),
    done: (reason: RunOutcome = 'completed'): ChatItem =>
      event({ seq: 0, type: 'done', reason, session: MAIN }),
    runState: (state: 'working' | 'waiting', groupedTasks: number): ChatItem =>
      event({ seq: 0, type: 'run_state', state, groupedTasks }),
    thinking: (active: boolean): ChatItem => event({ seq: 0, type: 'reasoning_activity', active }),
    failedRun: (error: string, messageId?: MessageId): ChatItem => {
      const item = event({ seq: 0, type: 'run_failed', error, session: MAIN });

      return item.type === 'event' && messageId ? { ...item, messageId } : item;
    },
    toolStarted: (id: string, description: string): ChatItem =>
      event({ seq: 0, type: 'tool_call_started', call: call(id), description }),
    /** The call `id` launched background work: the item a `start_agent` call becomes. */
    taskRunning: (id: string, description: string): ChatItem =>
      event(
        entryEventSchema.parse({
          seq: 0,
          type: 'task_running',
          call: { id, name: 'start_agent', input: {} },
          description,
          task: {
            id: 't1',
            callId: id,
            command: 'helper',
            description,
            kind: 'agent',
            status: 'running',
            startedAt: 1,
            output: '',
          },
          message: { role: 'tool', toolCallId: id, content: 'started', isError: false },
          durationMs: 1,
        }),
      ),
    toolResult: (id: string, description: string): ChatItem =>
      event({
        seq: 0,
        type: 'tool_result',
        call: call(id),
        description,
        message: {
          role: 'tool',
          toolCallId: callIdSchema.parse(id),
          content: 'ok',
          isError: false,
        },
        durationMs: 1,
      }),
    /** An event too large to store, which belonged to the tool call `call` when it names one. */
    omitted: (params: { eventType: string; call?: string }): ChatItem => ({
      type: 'event_omitted',
      eventType: params.eventType,
      seq: 0,
      size: 90_000,
      ...(params.call && { call: { id: callIdSchema.parse(params.call), name: 'run_command' } }),
    }),
    /** A sub-agent's card, at depth 2 under the main agent unless `depth` says another. */
    card: (change: 'started' | 'status' | 'ended', params: CardParams = {}): ChatItem => {
      const {
        node = 'worker',
        title = node,
        depth = 2,
        spawnedBy,
        status,
        state,
        outcome,
      } = params;

      return {
        type: 'agent',
        change,
        agent: {
          id: nodeIdSchema.parse(node),
          title,
          depth,
          parent: nodeIdSchema.parse('main'),
          root: nodeIdSchema.parse('main'),
          state: state ?? 'running',
          ...(status !== undefined && { status }),
          ...(outcome !== undefined && { outcome }),
          ...(spawnedBy !== undefined && { spawnedBy: callIdSchema.parse(spawnedBy) }),
        },
      };
    },
  };
}

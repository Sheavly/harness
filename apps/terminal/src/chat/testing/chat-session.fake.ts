import type { EntryEvent } from '@sheavly/protocol/event/event.types';
import { messageIdSchema } from '@sheavly/protocol/message/message.validator';
import type { ModelEffort } from '@sheavly/protocol/model/model.types';
import { modelIdSchema } from '@sheavly/protocol/model/model.validator';
import type { QueueUpdate } from '@sheavly/protocol/queue/queue.types';
import type { PromptSent } from '@sheavly/protocol/node-command/node-command.types';
import type { ModelChoice } from '@sheavly/protocol/server/server.types';
import type { RunOutcome } from '@sheavly/protocol/session/session.types';
import { sessionIdSchema } from '@sheavly/protocol/session/session.validator';
import type { StreamEntry } from '@sheavly/protocol/stream/stream.types';
import { Renderer } from '../../render/render.service.js';
import { startedAnswer } from './prompt-answers.fake.js';
import type { RunningTool } from '../../render/render.types.js';
import { ChatSession } from '../chat-session.service.js';
import type { ChatConversation, RunState, TurnOutcome } from '../chat.types.js';

export const MAIN_SESSION = sessionIdSchema.parse('main');
const REF = { id: MAIN_SESSION, rootId: MAIN_SESSION, depth: 1 } as const;
/** The message id every line the fake backend starts or refuses was accepted with. */
const LINE_MESSAGE = messageIdSchema.parse('00000000-0000-4000-8000-0000000000cf');

export const FAST = modelIdSchema.parse('4b1f9a52-3c5e-4a77-9d64-0e2b7f1c8a31');
export const DEEP = modelIdSchema.parse('9d2c7e10-6a4b-4f38-b1e5-5c0a8d3f2b72');
const MODELS: ModelChoice[] = [
  { id: FAST, name: 'Fast', adapter: 'openai', model: 'gpt-fast' },
  { id: DEEP, name: 'Deep', adapter: 'openai', model: 'gpt-deep' },
];

/**
 * Test-only: a conversation as the chat reaches it, recording what it was asked. Each submit is
 * answered by `answer` (the backend started it, by default); `skills` are the skills it has.
 */
export function fakeChatConversation(
  params: {
    skills?: string[];
    answer?: (text: string) => Promise<PromptSent>;
  } = {},
) {
  const submitted: string[] = [];
  const queuesSet: string[][] = [];
  let stops = 0;
  let model = FAST;
  const efforts = new Map<string, ModelEffort>();
  const answer = params.answer ?? (() => Promise.resolve(startedAnswer()));
  const conversation: ChatConversation = {
    submit: (text) => {
      submitted.push(text);

      return answer(text);
    },
    stop: () => {
      stops += 1;

      return Promise.resolve();
    },
    setQueue: (queued) => {
      queuesSet.push([...queued]);

      return Promise.resolve();
    },
    skills: () =>
      Promise.resolve(
        (params.skills ?? []).map((name) => ({
          name,
          description: '',
          manualOnly: false,
          scope: 'project' as const,
        })),
      ),
    details: () =>
      Promise.resolve({
        model: {
          ...MODELS.find((choice) => choice.id === model),
          effort: efforts.get(model) ?? 'medium',
        },
        models: MODELS,
      } as never),
    useModel: (id, effort) => {
      if (!MODELS.some((choice) => choice.id === id)) return Promise.resolve(false);
      model = id;
      if (effort) efforts.set(id, effort);

      return Promise.resolve(true);
    },
  };

  return { conversation, submitted, queuesSet, stops: () => stops, model: () => model };
}

/**
 * Test-only: a chat on `conversation` (a fake one by default), with every callback a UI gets
 * recorded in order, as `told`, and everything it wrote.
 */
export function recordingChat(params: { fake?: ReturnType<typeof fakeChatConversation> } = {}) {
  const fake = params.fake ?? fakeChatConversation();
  const written: string[] = [];
  const told: string[] = [];
  const queues: (readonly string[])[] = [];
  const runStates: RunState[] = [];
  const thinking: boolean[] = [];
  const tools: string[][] = [];
  const renderer = new Renderer((out) => written.push(out));
  const session = new ChatSession({
    conversation: fake.conversation,
    renderer,
    mainSession: MAIN_SESSION,
    write: (out) => written.push(out),
    onQueue: (queue) => queues.push(queue),
    onBusy: (busy) => told.push(busy ? 'busy' : 'ready'),
    onSend: (text) => told.push(`send ${text}`),
    onTurnEnd: (outcome: TurnOutcome) => told.push(`end ${outcome}`),
    onReplyComplete: () => told.push('reply'),
    onRunState: (state) => runStates.push(state),
    onThinking: (value) => thinking.push(value),
    onTools: (running: readonly RunningTool[]) =>
      tools.push(running.map(({ description }) => description)),
    onExit: () => told.push('exit'),
  });

  return {
    session,
    renderer,
    fake,
    told,
    queues,
    runStates,
    thinking,
    tools,
    output: () => written.join(''),
  };
}

/**
 * Test-only: the conversation's stream, as the backend numbers it: each entry it makes takes the
 * next seq, so the chat hears them in order.
 */
export function backendStream(session = MAIN_SESSION) {
  let seq = 0;
  const next = () => seq++;
  const event = (made: EntryEvent, sessionId = session): StreamEntry => {
    const at = next();

    return { seq: at, at: 0, sessionId, kind: 'event', event: { ...made, seq: at } };
  };
  const queue = (update: QueueUpdate): StreamEntry => ({
    seq: next(),
    at: 0,
    sessionId: MAIN_SESSION,
    kind: 'queue',
    update,
  });

  return {
    event,
    /** The main session resumes: a run starts, a wake until a `prompt_started` says it is a line. */
    resumed: (): StreamEntry => ({
      seq: next(),
      at: 0,
      sessionId: MAIN_SESSION,
      kind: 'update',
      update: {
        type: 'session_resumed',
        session: { ...REF, title: 'Main', state: 'running', startedAt: 0 },
      },
    }),
    idled: (): StreamEntry => ({
      seq: next(),
      at: 0,
      sessionId: MAIN_SESSION,
      kind: 'update',
      update: {
        type: 'session_idle',
        session: { ...REF, title: 'Main', state: 'idle', lastOutcome: 'completed', startedAt: 0 },
      },
    }),
    started: (text: string, queued: string[] = []) =>
      queue({ type: 'prompt_started', messageId: LINE_MESSAGE, text, queued }),
    changed: (queued: string[]) => queue({ type: 'queue_changed', queued }),
    refused: (text: string, error: string, queued: string[] = []) =>
      queue({ type: 'prompt_refused', messageId: LINE_MESSAGE, text, error, queued }),
    text: (value: string, sessionId = session) =>
      event({ seq: 0, type: 'text_delta', text: value }, sessionId),
    done: (reason: RunOutcome = 'completed') =>
      event({ seq: 0, type: 'done', reason, session: REF }),
    runState: (state: 'working' | 'waiting', groupedTasks: number, sessionId = session) =>
      event({ seq: 0, type: 'run_state', state, groupedTasks }, sessionId),
    thinking: (active: boolean, sessionId = session) =>
      event({ seq: 0, type: 'reasoning_activity', active }, sessionId),
  };
}

/** Test-only: hears each entry, in order. */
export function hearAll(params: { session: ChatSession; entries: StreamEntry[] }): void {
  for (const entry of params.entries) params.session.hear(entry);
}

/** Test-only: lets the chat's pending requests answer. */
export const settle = () => new Promise((resolve) => setTimeout(resolve, 5));

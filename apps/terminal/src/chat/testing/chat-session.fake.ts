import type { MessageId } from '@sheavly/protocol/message/message.types';
import { modelIdSchema } from '@sheavly/protocol/model/model.validator';
import type { ModelEffort } from '@sheavly/protocol/model/model.types';
import type { PromptSent } from '@sheavly/protocol/node-command/node-command.types';
import type { ModelChoice } from '@sheavly/protocol/server/server.types';
import type { ChatItem } from '../../client/transcript.types.js';
import { Renderer } from '../../render/render.service.js';
import type { RunningTool } from '../../render/render.types.js';
import { ChatSession } from '../chat-session.service.js';
import type { ChatConversation, RunState, TurnOutcome } from '../chat.types.js';
import { feedItems, messageIdOf } from './feed-items.fake.js';
import { lineChatDetails } from './line-chat.fake.js';
import { queuedAnswer, startedAnswer } from './prompt-answers.fake.js';

export const FAST = modelIdSchema.parse('4b1f9a52-3c5e-4a77-9d64-0e2b7f1c8a31');
export const DEEP = modelIdSchema.parse('9d2c7e10-6a4b-4f38-b1e5-5c0a8d3f2b72');
const FAST_CHOICE: ModelChoice = { id: FAST, name: 'Fast', adapter: 'openai', model: 'gpt-fast' };
const MODELS: ModelChoice[] = [
  FAST_CHOICE,
  { id: DEEP, name: 'Deep', adapter: 'openai', model: 'gpt-deep' },
];

/** Test-only: the backend's answer to a line, started at once or queued, with the id it took. */
export function lineAnswer(params: {
  status: 'started' | 'queued';
  messageId: MessageId;
  queued?: string[];
}): PromptSent {
  const { status, messageId, queued = [] } = params;

  return { ...(status === 'started' ? startedAnswer(queued) : queuedAnswer(queued)), messageId };
}

/**
 * Test-only: a conversation as the chat reaches it, recording what it was asked. Each submit takes
 * the next message id (`ids`, in the order sent) and is answered by `answer` (the backend started
 * it, by default); `skills` are the skills it has.
 */
export function fakeChatConversation(
  params: {
    skills?: string[];
    answer?: (line: { text: string; messageId: MessageId }) => Promise<PromptSent>;
  } = {},
) {
  const submitted: string[] = [];
  const ids: MessageId[] = [];
  const queuesSet: string[][] = [];
  let stops = 0;
  let model = FAST;
  const efforts = new Map<string, ModelEffort>();
  const answer =
    params.answer ??
    (({ messageId }) => Promise.resolve(lineAnswer({ status: 'started', messageId })));
  const conversation: ChatConversation = {
    submit: (text) => {
      const messageId = messageIdOf(ids.length + 1);

      submitted.push(text);
      ids.push(messageId);

      return answer({ text, messageId });
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
        ...lineChatDetails,
        model: {
          ...(MODELS.find((choice) => choice.id === model) ?? FAST_CHOICE),
          effort: efforts.get(model) ?? 'medium',
        },
        models: MODELS,
      }),
    useModel: (id, effort) => {
      if (!MODELS.some((choice) => choice.id === id)) return Promise.resolve(false);
      model = id;
      if (effort) efforts.set(id, effort);

      return Promise.resolve(true);
    },
  };

  return { conversation, submitted, ids, queuesSet, stops: () => stops, model: () => model };
}

/**
 * Test-only: a chat on `conversation` (a fake one by default), with every callback a UI gets
 * recorded in order, as `told`, and everything it wrote. `items` builds what the feed hands it.
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
    items: feedItems(),
    told,
    queues,
    runStates,
    thinking,
    tools,
    output: () => written.join(''),
  };
}

/** Test-only: hears each item, in order. */
export function hearAll(params: { session: ChatSession; items: ChatItem[] }): void {
  for (const item of params.items) params.session.hear(item);
}

/** Test-only: lets the chat's pending requests answer. */
export const settle = () => new Promise((resolve) => setTimeout(resolve, 5));

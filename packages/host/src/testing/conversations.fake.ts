import type { StreamEvent } from '@sheavly/core/message/message.types';
import type { ConversationStore } from '@sheavly/core/store/store.types';
import { streamAgent } from '@sheavly/loop/stream-agent/stream-agent.helper';
import { blockTool } from '@sheavly/runtime/testing/block-tool.fake';
import { toolCall } from '@sheavly/testing/provider/routed-provider.fake';
import { scriptedProvider } from '@sheavly/testing/provider/scripted-provider.fake';
import type { Message } from '@sheavly/protocol/message/message.types';
import type { ConversationId } from '@sheavly/protocol/server/server.types';
import { createConversation } from '../conversation/conversation.helper.js';
import { Conversations } from '../conversations/conversations.service.js';
import type {
  ConversationSkills,
  CreateConversation,
} from '../conversations/conversations.types.js';
import { createHarness } from '../host/host.helper.js';
import { twoModelRun } from './run.fake.js';
import { reviewSkill } from './skills.fake.js';
import { harnessStorageOptions } from './storage-options.fake.js';

/** Test-only: a model turn that says `text` and ends. */
export const say = (text: string): StreamEvent[] => [
  { type: 'text_delta', text },
  { type: 'done', stopReason: 'end_turn' },
];

/**
 * Test-only: the replies of a model that calls the `block` tool, which waits until the prompt is
 * stopped, and answers `next` to the prompt after it.
 */
export const blockedThenNext = (): StreamEvent[][] => [
  [toolCall({ id: 'b1', name: 'block', input: {} }), { type: 'done', stopReason: 'tool_use' }],
  say('next'),
];

/**
 * Test-only: sends a prompt to a conversation whose model blocks (`blockedThenNext`), calls `stop`
 * once its tool call has started, and returns the type of the last event the run gave and the
 * roles of the history it left: a stopped prompt ends `done` with its tool call answered.
 */
export async function stopWhenBlocked(params: {
  conversations: Conversations;
  id: ConversationId;
  stop: () => Promise<void> | void;
}): Promise<{ last: string | undefined; roles: string[] }> {
  const { conversations, id } = params;
  const { events } = await conversations.send({ id, prompt: { text: 'wait' } });
  let last: string | undefined;

  for await (const event of events) {
    last = event.type;

    if (event.type === 'tool_call_started') await params.stop();
  }

  return { last, roles: conversations.messages(id).map((message) => message.role) };
}

/**
 * Test-only: `Conversations` on a scripted model, each conversation built as a backend builds
 * one. With a `store`, it wires the `storage` the host hands `create` the way an app must: the
 * stream to `entries`, the log to `resume`, the nodes' channels to `channels`, and `keepHistory`
 * into the conversation, which is
 * `resumed` when reopened. `sent` is the history each model call was sent.
 */
export function scriptedConversations(params: {
  replies: StreamEvent[][];
  withSkills?: boolean;
  /** Skills of its own, for a test that controls when a prompt is prepared. */
  skills?: ConversationSkills;
  store?: ConversationStore;
}) {
  const sent: Message[][] = [];
  const disposed: string[] = [];
  const created: Parameters<CreateConversation>[0][] = [];
  const conversations = new Conversations({
    ...(params.store && { store: params.store }),
    create: async (asked) => {
      created.push(asked);

      const { messages, storage } = asked;
      const scripted = scriptedProvider(params.replies);
      const harness = createHarness({
        provider: {
          stream: (request) => {
            sent.push(request.messages);

            return scripted.stream(request);
          },
        },
        title: 'Chat',
        ...harnessStorageOptions(storage),
      });

      return {
        harness,
        conversation: createConversation({
          harness,
          run: streamAgent,
          tools: [blockTool],
          messages: messages ?? [],
          ...(storage && {
            keepHistory: storage.keepHistory,
            resumed: storage.resume !== undefined,
          }),
        }),
        ...((params.skills ?? params.withSkills) && {
          skills: params.skills ?? reviewSkill,
        }),
        run: twoModelRun(),
        dispose: async () => {
          disposed.push('disposed');
        },
      };
    },
  });

  return { conversations, sent, disposed, created };
}

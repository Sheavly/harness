import type { StreamEvent } from '@sheavly/core/message/message.types';
import type { ConversationStore } from '@sheavly/core/store/store.types';
import { streamAgent } from '@sheavly/loop/stream-agent/stream-agent.helper';
import { blockTool } from '@sheavly/runtime/testing/block-tool.fake';
import { scriptedProvider } from '@sheavly/testing/provider/scripted-provider.fake';
import type { Message } from '@sheavly/protocol/message/message.types';
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

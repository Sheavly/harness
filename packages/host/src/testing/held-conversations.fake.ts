import type { ConversationStore } from '@sheavly/core/store/store.types';
import { streamAgent } from '@sheavly/loop/stream-agent/stream-agent.helper';
import type { ConversationId } from '@sheavly/protocol/server/server.types';
import type { StreamEntry } from '@sheavly/protocol/stream/stream.types';
import { until } from '@sheavly/testing/wait/until.fake';
import { createConversation } from '../conversation/conversation.helper.js';
import { Conversations } from '../conversations/conversations.service.js';
import type { ConversationSkills, PromptFailure } from '../conversations/conversations.types.js';
import { createHarness } from '../host/host.helper.js';
import { twoModelRun } from './run.fake.js';
import { harnessStorageOptions } from './storage-options.fake.js';

/** Test-only: skills that know none: a prompt `/nope` names one that does not exist. */
export const NO_SKILLS: ConversationSkills = {
  list: async () => [],
  prepare: async ({ prompt }) =>
    'text' in prompt && prompt.text.startsWith('/nope')
      ? { unknown: ['nope'] }
      : { text: 'text' in prompt ? prompt.text : '' },
};

/**
 * Test-only: skills that wait while preparing the text prompt `text` until a stop aborts it, as
 * the backend's skill reader does; `reached` settles once one waits. With `once`, only the first
 * preparation of it waits.
 */
export function stoppableSkills(params: { text: string; once?: boolean }) {
  const reached = Promise.withResolvers<undefined>();
  let waited = false;
  const skills: ConversationSkills = {
    ...NO_SKILLS,
    prepare: async ({ prompt, signal }) => {
      if ('text' in prompt && prompt.text === params.text && !(params.once && waited)) {
        waited = true;
        reached.resolve(undefined);
        await new Promise((_resolve, reject) =>
          signal?.addEventListener('abort', () => reject(signal.reason as Error)),
        );
      }

      return NO_SKILLS.prepare({ prompt });
    },
  };

  return { skills, reached: reached.promise };
}

/** What `heldConversations` is given. */
type HeldParams = {
  held?: number[];
  store?: ConversationStore;
  skills?: ConversationSkills;
  onPromptFailure?: (failure: PromptFailure) => void;
};

/**
 * Test-only: `Conversations` on a model that answers each call with the prompt it was given,
 * except that the calls numbered in `held` (1-based) wait until `release(n)`. `prompts` is the
 * last user message of each call, in order.
 */
export function heldConversations(params: HeldParams = {}) {
  const gates = new Map((params.held ?? []).map((n) => [n, Promise.withResolvers<undefined>()]));
  const prompts: string[] = [];
  const conversations = new Conversations({
    ...(params.store && { store: params.store }),
    ...(params.onPromptFailure && { onPromptFailure: params.onPromptFailure }),
    create: async ({ storage }) => {
      const harness = createHarness({
        title: 'Chat',
        provider: {
          async *stream(request) {
            const user = request.messages.findLast((m) => m.role === 'user');

            prompts.push(user?.content ?? '');
            await gates.get(prompts.length)?.promise;
            yield { type: 'text_delta', text: 'ok' };
            yield { type: 'done', stopReason: 'end_turn' };
          },
        },
        ...harnessStorageOptions(storage),
      });

      return {
        harness,
        conversation: createConversation({
          harness,
          run: streamAgent,
          tools: [],
          ...(storage && {
            keepHistory: storage.keepHistory,
            resumed: storage.resume !== undefined,
          }),
        }),
        skills: params.skills ?? NO_SKILLS,
        run: twoModelRun(),
      };
    },
  });

  return {
    conversations,
    prompts,
    release: (n: number) => gates.get(n)?.resolve(undefined),
  };
}

/** Test-only: every entry of conversation `id`'s stream from now on. */
export function follow(params: { conversations: Conversations; id: ConversationId }) {
  const entries: StreamEntry[] = [];

  params.conversations.get(params.id).harness.sessions.subscribeEntries((e) => entries.push(e));

  return entries;
}

/** Test-only: the queue entries of a stream, as `type text? [queued]`. */
export const queueOf = (entries: readonly StreamEntry[]) =>
  entries.flatMap((entry) =>
    entry.kind === 'queue'
      ? [
          `${entry.update.type}${'text' in entry.update ? ` ${entry.update.text}` : ''} [${entry.update.queued.join(', ')}]`,
        ]
      : [],
  );

/** Test-only: lets a run the test released end, so the conversation is idle again. */
export const idle = (params: { conversations: Conversations; id: ConversationId }) =>
  until(() => params.conversations.get(params.id).conversation.state === 'idle');

/**
 * Test-only: a conversation whose prompt `first` runs, held at its model call until `release(1)`;
 * `send` submits a text prompt to it.
 */
export async function runningFirst(params: Omit<HeldParams, 'held'> = {}) {
  const held = heldConversations({ ...params, held: [1] });
  const id = await held.conversations.start();
  const send = (text: string) => held.conversations.submit({ id, prompt: { text } });

  await send('first');
  await until(() => held.prompts.length === 1);

  return { ...held, id, send };
}

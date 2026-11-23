import { describe, expect, it } from 'vitest';
import { StoreError } from '@sheavly/core/errors/store.errors';
import { readHistoryEntries } from '@sheavly/core/store/history-log.helper';
import type { HistoryLog } from '@sheavly/core/store/store.types';
import type { ConversationId } from '@sheavly/protocol/server/server.types';
import type { SessionId } from '@sheavly/protocol/session/session.types';
import { collect } from '@sheavly/testing/fetch/fake-fetch.fake';
import { useFixedClock } from '@sheavly/testing/clock/fixed-clock.fake';
import { MemoryConversationStore } from '@sheavly/testing/store/memory-store.fake';
import { indexOf } from '@sheavly/testing/store/store-contract.fake';
import { callIdSchema } from '@sheavly/protocol/message/message.validator';
import { conversationIdSchema } from '@sheavly/protocol/server/server.validator';
import { sessionIdSchema } from '@sheavly/protocol/session/session.validator';
import type { HistoryMessage } from '@sheavly/protocol/history/history.types';
import { historyMessageSchema } from '@sheavly/protocol/history/history.validator';
import { say, scriptedConversations as setup } from '../../testing/conversations.fake.js';
import {
  loggedSeqs,
  seedAgentSession,
  seedMainSession,
} from '../../testing/stored-conversation.fake.js';
import { FAST_ID } from '../../testing/run.fake.js';

const ID = conversationIdSchema.parse('00000000-0000-4000-8000-0000000000dd');

/** A sub-agent history whose final reply is `text`, after some work that is not the report. */
const childHistory = (text: string): HistoryMessage[] => [
  { role: 'user', content: 'task', at: 1 },
  { role: 'assistant', content: 'working on it', toolCalls: [], at: 2 },
  { role: 'user', content: 'again', at: 3 },
  { role: 'assistant', content: text, toolCalls: [], at: 4 },
];

/** A store whose history log for the sub-agent `broken` fails to read, as a damaged file would. */
class BrokenAgentStore extends MemoryConversationStore {
  constructor(readonly broken: string) {
    super();
  }

  override history(params: { id: ConversationId; session?: SessionId | undefined }): HistoryLog {
    const log = super.history(params);

    if (params.session !== this.broken) return log;

    return {
      append: async (records) => log.append(records),
      read: () => ({
        [Symbol.asyncIterator]: () => ({
          next: async () => {
            throw new StoreError({ reason: 'failed', message: 'unreadable history' });
          },
        }),
      }),
    };
  }
}

async function storedWithAgents(
  agents: readonly {
    agent: string;
    outcome: 'completed' | 'failed' | 'running';
    messages?: readonly HistoryMessage[];
  }[],
  store: MemoryConversationStore = new MemoryConversationStore(),
) {
  await store
    .history({ id: ID })
    .append([{ seq: 0, entry: { role: 'user', content: 'go', at: 1 } }]);
  await store.writeIndex({ ...indexOf(ID, 1), modelId: FAST_ID, updatedAt: 2 });
  await seedMainSession({ store, id: ID, state: 'idle' });

  let firstSeq = 1;

  for (const { agent, outcome, messages = childHistory(`findings of ${agent}`) } of agents) {
    firstSeq = await seedAgentSession({ store, id: ID, agent, outcome, firstSeq, messages });
  }

  return store;
}

const notices = (messages: readonly HistoryMessage[]) =>
  messages.flatMap((message) => (message.role === 'notice' ? [message.notice] : []));

/** Stores a conversation with `agents`, reopens it, and returns the notices its history holds. */
async function noticesAfterReopen(
  agents: Parameters<typeof storedWithAgents>[0],
  store?: MemoryConversationStore,
) {
  const { conversations } = setup({ store: await storedWithAgents(agents, store), replies: [] });

  await conversations.reopen(ID);

  return notices(conversations.messages(ID));
}

describe('reopening a conversation whose sub-agent report was never delivered', () => {
  useFixedClock();

  it('delivers the report read back from the sub-agent’s stored history, with no task id', async () => {
    const store = await storedWithAgents([{ agent: 'a', outcome: 'completed' }]);
    const { conversations } = setup({ store, replies: [say('ok')] });

    await conversations.reopen(ID);

    const [notice, ...rest] = notices(conversations.messages(ID));

    expect(rest).toEqual([]);
    expect(notice).toMatchObject({
      kind: 'agent-report',
      outcome: 'completed',
      report: 'findings of a',
      agent: { id: 'a', title: 'Agent a' },
    });
    expect(notice !== undefined && 'taskId' in notice).toBe(false);
  });

  it('tells the model at its next prompt, once, and starts no run by itself', async () => {
    const store = await storedWithAgents([{ agent: 'a', outcome: 'completed' }]);
    const { conversations, sent } = setup({ store, replies: [say('ok')] });

    await conversations.reopen(ID);
    expect(sent).toEqual([]);

    await collect(
      (await conversations.send({ id: ID, prompt: { text: 'what did it say?' } })).events,
    );

    const seen = JSON.stringify(sent[0]);

    expect(seen).toContain('findings of a');
    expect(seen.split('findings of a')).toHaveLength(2);
  });

  it('says an interrupted or failed sub-agent ended, with an empty report', async () => {
    expect(
      await noticesAfterReopen([
        { agent: 'a', outcome: 'running' },
        { agent: 'b', outcome: 'failed' },
      ]),
    ).toMatchObject([
      { kind: 'agent-report', outcome: 'interrupted', report: '', agent: { id: 'a' } },
      { kind: 'agent-report', outcome: 'failed', report: '', agent: { id: 'b' } },
    ]);
  });

  it('says a completed sub-agent with no stored history was interrupted', async () => {
    expect(
      await noticesAfterReopen([{ agent: 'a', outcome: 'completed', messages: [] }]),
    ).toMatchObject([
      { kind: 'agent-report', outcome: 'interrupted', report: '', agent: { id: 'a' } },
    ]);
  });

  it('still reopens when one sub-agent’s history cannot be read, and reports the others', async () => {
    expect(
      await noticesAfterReopen(
        [
          { agent: 'a', outcome: 'completed' },
          { agent: 'b', outcome: 'completed' },
        ],
        new BrokenAgentStore('a'),
      ),
    ).toMatchObject([
      { outcome: 'interrupted', report: '', agent: { id: 'a' } },
      { outcome: 'completed', report: 'findings of b', agent: { id: 'b' } },
    ]);
  });

  it('logs the notice after the history, so reopening again adds nothing', async () => {
    const store = await storedWithAgents([{ agent: 'a', outcome: 'completed' }]);
    const first = setup({ store, replies: [] });

    await first.conversations.reopen(ID);
    await first.conversations.get(ID).harness.sessions.flushStore();
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    await first.conversations.close(ID);

    expect(await loggedSeqs({ store, id: ID })).toEqual([0, 1]);

    const second = setup({ store, replies: [] });

    await second.conversations.reopen(ID);

    const reopened = notices(second.conversations.messages(ID));

    await second.conversations.close(ID);

    expect(await loggedSeqs({ store, id: ID })).toEqual([0, 1]);
    expect(notices(await readHistoryEntries(store.history({ id: ID })))).toHaveLength(1);
    expect(reopened).toHaveLength(1);
  });

  it('delivers the report of a sub-agent whose release was stored but whose report never reached history', async () => {
    const store = await storedWithAgents([{ agent: 'a', outcome: 'completed' }]);

    // The loop releases a sub-agent as its report enters the history; a crash can keep the release.
    await store.entries(ID).append({
      seq: 3,
      at: 4,
      sessionId: sessionIdSchema.parse('a'),
      kind: 'update',
      update: {
        type: 'session_released',
        session: {
          id: sessionIdSchema.parse('a'),
          parentId: sessionIdSchema.parse('main'),
          startedByCall: callIdSchema.parse('call-a'),
          rootId: sessionIdSchema.parse('main'),
          depth: 2,
          title: 'Agent a',
          state: 'completed',
          startedAt: 2,
          endedAt: 3,
          lastOutcome: 'completed',
        },
      },
    });

    const { conversations } = setup({ store, replies: [] });

    await conversations.reopen(ID);

    expect(notices(conversations.messages(ID))).toMatchObject([
      { kind: 'agent-report', outcome: 'completed', report: 'findings of a', agent: { id: 'a' } },
    ]);
    // It is released, as it was: not a live session of the reopened conversation.
    expect(conversations.get(ID).harness.sessions.isReleased(sessionIdSchema.parse('a'))).toBe(
      true,
    );
  });

  it('leaves a sub-agent already reported in history alone', async () => {
    const store = await storedWithAgents([{ agent: 'a', outcome: 'completed' }]);

    await store.history({ id: ID }).append([
      {
        seq: 1,
        entry: historyMessageSchema.parse({
          role: 'notice',
          at: 5,
          notice: {
            kind: 'agent-report',
            taskId: 't1',
            outcome: 'completed',
            report: 'delivered',
            context: { reason: 'wait', startedAt: 2, durationMs: 1, userMessagesSinceStart: 0 },
            agent: {
              id: 'a',
              parentId: 'main',
              startedByCall: 'call-a',
              rootId: 'main',
              depth: 2,
              title: 'Agent a',
              state: 'completed',
              startedAt: 2,
              endedAt: 4,
              lastOutcome: 'completed',
            },
          },
        }),
      },
    ]);

    const { conversations } = setup({ store, replies: [] });

    await conversations.reopen(ID);

    expect(notices(conversations.messages(ID))).toMatchObject([{ report: 'delivered' }]);
  });
});

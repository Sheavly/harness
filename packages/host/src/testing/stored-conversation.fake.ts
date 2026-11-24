import { collect } from '@sheavly/testing/fetch/fake-fetch.fake';
import type { MemoryConversationStore } from '@sheavly/testing/store/memory-store.fake';
import type { ConversationId } from '@sheavly/protocol/server/server.types';
import type { HistoryMessage } from '@sheavly/protocol/history/history.types';
import type { SessionUpdate } from '@sheavly/protocol/session/session.types';
import type { StreamEntry } from '@sheavly/protocol/stream/stream.types';
import { callIdSchema } from '@sheavly/protocol/message/message.validator';
import { sessionIdSchema } from '@sheavly/protocol/session/session.validator';
import { say, scriptedConversations } from './conversations.fake.js';

const MAIN = sessionIdSchema.parse('main');

/**
 * Test-only: a conversation on `store` that ran one prompt (the model said "one") and was left
 * open, as a process that ended without closing it leaves it. `conversations` is the host that ran
 * it, to close it or to ask for what it kept.
 */
export async function ranOnePrompt(store: MemoryConversationStore) {
  const { conversations } = scriptedConversations({ store, replies: [say('one')] });
  const id = await conversations.start();

  await collect((await conversations.send({ id, prompt: { text: 'first' } })).events);

  return { id, conversations };
}

/**
 * Test-only: writes the first stream entry of a stored conversation, its main session started in
 * `state`: `idle` for one that ended well (it takes the next prompt), `running` for one the
 * process left mid-run.
 */
export async function seedMainSession(params: {
  store: MemoryConversationStore;
  id: ConversationId;
  state: 'idle' | 'running';
}): Promise<void> {
  const { store, id, state } = params;

  await store.entries(id).append({
    seq: 0,
    at: 1,
    sessionId: MAIN,
    kind: 'update',
    update: {
      type: 'session_started',
      session: { id: MAIN, rootId: MAIN, depth: 1, title: 'Chat', state, startedAt: 1 },
    },
  });
}

/**
 * Test-only: writes the stream entries of a sub-agent of the stored main session, from `firstSeq`
 * (after `seedMainSession`), and returns the next free `seq`: started, and ended with `outcome` unless it is left `running`, as a
 * process that ended mid-run leaves it. Its own history is `messages`.
 */
export async function seedAgentSession(params: {
  store: MemoryConversationStore;
  id: ConversationId;
  agent: string;
  outcome: 'completed' | 'failed' | 'running';
  messages?: readonly HistoryMessage[];
  /** The stream `seq` its first entry gets (default 1, after the main session's). */
  firstSeq?: number;
}): Promise<number> {
  const { store, id, agent, outcome, messages = [], firstSeq = 1 } = params;
  const session = sessionIdSchema.parse(agent);
  const info = {
    id: session,
    parentId: MAIN,
    startedByCall: callIdSchema.parse(`call-${agent}`),
    rootId: MAIN,
    depth: 2,
    title: `Agent ${agent}`,
    startedAt: 2,
  };
  const entry = (seq: number, update: SessionUpdate): StreamEntry => ({
    seq,
    at: 2,
    sessionId: session,
    kind: 'update',
    update,
  });

  await store
    .entries(id)
    .append(entry(firstSeq, { type: 'session_started', session: { ...info, state: 'running' } }));

  await store
    .history({ id, session })
    .append(messages.map((message, index) => ({ seq: index, entry: message })));

  if (outcome === 'running') return firstSeq + 1;

  await store.entries(id).append(
    entry(firstSeq + 1, {
      type: 'session_ended',
      session: { ...info, state: outcome, lastOutcome: outcome, endedAt: 3 },
    }),
  );

  return firstSeq + 2;
}

/** Test-only: the `seq` of every record in conversation `id`'s main history log, in order. */
export async function loggedSeqs(params: {
  store: MemoryConversationStore;
  id: ConversationId;
}): Promise<number[]> {
  const seqs: number[] = [];

  for await (const record of params.store.history({ id: params.id }).read()) seqs.push(record.seq);

  return seqs;
}

import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { ChannelLog, HistoryLog } from '@sheavly/core/store/store.types';
import type { ConversationStorage } from '@sheavly/host/conversations/conversations.types';
import { promptEntries } from '@sheavly/client/prompt/prompt.helper';
import { fakeFetch } from '@sheavly/testing/fetch/fake-fetch.fake';
import { profileIdSchema } from '@sheavly/protocol/profile/profile.validator';
import { modelIdSchema } from '@sheavly/protocol/model/model.validator';
import { testBackend } from '../../testing/backend.fake.js';
import { SessionRegistry } from '@sheavly/runtime/sessions/sessions.service';
import { sessionIdSchema } from '@sheavly/protocol/session/session.validator';
import type { EntryEvent } from '@sheavly/protocol/event/event.types';
import type { StreamEntry } from '@sheavly/protocol/stream/stream.types';
import { MemoryOutputStore } from '@sheavly/testing/store/memory-output.fake';
import { memoryShellStore } from '@sheavly/workspace/working-root/memory-shell.helper';
import { trackConversationUsage } from '../conversation-usage.helper.js';

let root = '';

/** What a log with nothing in it reads: no entry. */
const nothing: AsyncIterable<never> = {
  [Symbol.asyncIterator]: () => ({ next: async () => ({ done: true, value: undefined }) }),
};

/** A history log with nothing in it: these tests only read the stream, never the history. */
const emptyLog: HistoryLog = { append: async () => undefined, read: () => nothing };

/** A channel log that keeps nothing: these tests never run a node whose channel is stored. */
const emptyChannel: ChannelLog = {
  append: async () => undefined,
  head: async () => ({ count: 0, newest: undefined }),
  read: () => nothing,
};

/** The storage a host hands a conversation, whose stream holds `entries` and resumes from `resume`. */
function storageThatReads(params: {
  entries: StreamEntry[];
  resume: NonNullable<ConversationStorage['resume']>;
}): ConversationStorage {
  return {
    keepHistory: () => undefined,
    keepAgentHistory: () => undefined,
    logOf: () => emptyLog,
    channels: { log: () => emptyChannel },
    shell: memoryShellStore(),
    outputs: new MemoryOutputStore(),
    resume: params.resume,
    entries: {
      append: async () => undefined,
      async *read() {
        yield* params.entries;
      },
    },
  };
}

afterEach(async () => {
  if (root) await rm(root, { recursive: true, force: true });
});

describe('conversation usage over the API', () => {
  it('restores usage outside the bounded tail and marks earlier history without counts as incomplete', async () => {
    const sessionId = sessionIdSchema.parse('main');
    const usage: StreamEntry = {
      seq: 0,
      at: 0,
      sessionId,
      kind: 'event',
      event: {
        seq: 0,
        type: 'usage',
        usage: {
          tokens: { inputTokens: 100, outputTokens: 20, cacheReadTokens: 0, cacheWriteTokens: 0 },
          estimatedCostUsd: 0.25,
        },
      },
    };
    const turn: StreamEntry = {
      seq: 1,
      at: 0,
      sessionId,
      kind: 'event',
      event: { seq: 1, type: 'turn_end', turn: 1, stopReason: 'end_turn' },
    };
    const oldTurn: StreamEntry = { ...turn, seq: 2 };
    const tracked = await trackConversationUsage({
      sessions: new SessionRegistry(),
      storage: storageThatReads({
        entries: [usage, turn, oldTurn],
        resume: { next: 3, tail: [oldTurn], sessions: [], lastTokens: [] },
      }),
    });

    expect(tracked.ledger.snapshot).toMatchObject({
      calls: 1,
      inputTokens: 100,
      estimatedCostUsd: 0.25,
      incomplete: true,
      throughSeq: 2,
    });
    tracked.stop();
  });

  it('counts a summary call’s cost, but a turn that reported none is still incomplete', async () => {
    const sessionId = sessionIdSchema.parse('main');
    const tokens = { inputTokens: 900, outputTokens: 60, cacheReadTokens: 0, cacheWriteTokens: 0 };
    const entry = (seq: number, event: EntryEvent): StreamEntry => ({
      seq,
      at: 0,
      sessionId,
      kind: 'event',
      event,
    });
    const summaryUsage = entry(0, {
      seq: 0,
      type: 'usage',
      usage: { tokens, purpose: 'summary', estimatedCostUsd: 0.1 },
    });
    const turnEnd = entry(1, { seq: 1, type: 'turn_end', turn: 1, stopReason: 'end_turn' });
    const tracked = await trackConversationUsage({
      sessions: new SessionRegistry(),
      storage: storageThatReads({
        entries: [summaryUsage, turnEnd],
        resume: { next: 2, tail: [turnEnd], sessions: [], lastTokens: [] },
      }),
    });

    expect(tracked.ledger.snapshot).toMatchObject({
      calls: 1,
      estimatedCostUsd: 0.1,
      incomplete: true,
    });
    tracked.stop();
  });

  it('keeps recorded cost across resume and uses the newly configured price only for new calls', async () => {
    root = await mkdtemp(path.join(tmpdir(), 'usage-backend-'));
    const workspace = path.join(root, 'workspace');

    await mkdir(workspace);
    const { fetch } = fakeFetch([
      {
        type: 'response.completed',
        response: {
          usage: {
            input_tokens: 100,
            output_tokens: 20,
            input_tokens_details: { cached_tokens: 50 },
          },
        },
      },
    ]);
    const backend = testBackend({ home: path.join(root, 'home'), workspace, fetch });
    const { client } = backend;
    const profile = profileIdSchema.parse('00000000-0000-4000-8000-000000000001');
    const model = modelIdSchema.parse('00000000-0000-4000-8000-000000000002');
    const definition = { name: 'Priced', adapter: 'openai', definition: { model: 'test' } };

    try {
      await client.send('putProfile', { profile, body: { name: 'Work' } });
      await client.send('putModel', {
        profile,
        model,
        body: { ...definition, pricing: { input: 2, output: 8, cacheRead: 0.2, cacheWrite: 2.5 } },
      });
      await client.send('putCredential', { profile, model, body: { secrets: { apiKey: 'fake' } } });
      await client.send('setDefaultProfile', { body: { profile } });
      const { id } = await client.call('startConversation', { body: {} });

      expect((await client.call('getConversation', { id })).contextUsage).toMatchObject({
        window: 300_000,
      });

      for (const text of ['first', 'second']) {
        for await (const _entry of promptEntries({ client, id, prompt: { text } })) {
          // Drain the stream so its final usage and history have been recorded.
        }
      }

      expect((await client.call('getConversation', { id })).usage).toMatchObject({
        calls: 2,
        inputTokens: 200,
        outputTokens: 40,
        cacheReadTokens: 100,
        estimatedCostUsd: 0.00054,
        unpricedCalls: 0,
        missingUsageCalls: 0,
      });
      expect((await client.call('getConversation', { id })).contextUsage).toMatchObject({
        used: 120,
        cached: 50,
        window: 300_000,
      });
      await client.send('closeConversation', { id });
      await client.send('putModel', {
        profile,
        model,
        body: {
          ...definition,
          contextWindow: 1_000_000,
          pricing: { input: 4, output: 16, cacheRead: 0.4, cacheWrite: 5 },
        },
      });
      await client.call('reopenConversation', { id });
      expect((await client.call('getConversation', { id })).contextUsage).toMatchObject({
        used: 120,
        cached: 50,
        window: 1_000_000,
      });
      expect((await client.call('getConversation', { id })).usage?.estimatedCostUsd).toBeCloseTo(
        0.00054,
      );

      for await (const _entry of promptEntries({ client, id, prompt: { text: 'third' } })) {
        // The new call is priced with the provider built on reopen, not the earlier call's rates.
      }

      const totals = (await client.call('getConversation', { id })).usage;

      expect(totals?.calls).toBe(3);
      expect(totals?.estimatedCostUsd).toBeCloseTo(0.00108);
    } finally {
      await backend.conversations.closeAll();
    }
  });
});

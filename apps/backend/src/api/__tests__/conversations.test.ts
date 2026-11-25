import { describe, expect, it } from 'vitest';
import { toolCall } from '@sheavly/testing/provider/routed-provider.fake';
import { MemoryConversationStore } from '@sheavly/testing/store/memory-store.fake';
import { readEntries } from '@sheavly/client/client/entries.helper';
import { promptSentSchema } from '@sheavly/protocol/node-command/node-command.validator';
import { conversationIdSchema } from '@sheavly/protocol/server/server.validator';
import type { StreamEntry } from '@sheavly/protocol/stream/stream.types';
import { DEEP_ID, FAST_ID } from '@sheavly/host/testing/run.fake';
import { reply, testApi } from '../../testing/api.fake.js';

/** A well-formed id that no conversation's models have. */
const UNKNOWN_ID = '00000000-0000-4000-8000-000000000000';

const calls = (name: string) => () => [
  toolCall({ id: 'c1', name, input: {} }),
  { type: 'done' as const, stopReason: 'tool_use' as const },
];

/** One line per entry, for comparing streams: `kind:type`. */
const kindOf = (entry: StreamEntry) =>
  `${entry.kind}:${entry.kind === 'event' ? entry.event.type : entry.update.type}`;

describe('a conversation over HTTP', () => {
  it('answers a prompt at once with JSON: started when idle, queued behind a run that goes', async () => {
    const { request, start } = testApi({ wait: [calls('block')], next: [reply('ok')] });
    const id = await start();
    const send = (text: string) =>
      request(`/conversations/${id}/prompts`, { method: 'POST', body: { text } });
    const first = await send('wait');

    expect(first.headers.get('content-type')).toMatch(/application\/json/);
    // Both parse as the contract's answer: the node that carries the run, the message only for the
    // prompt that started.
    const started = promptSentSchema.parse(await first.json());
    const queued = promptSentSchema.parse(await (await send('next')).json());

    expect(started).toMatchObject({ status: 'started', queued: [] });
    expect(started).toHaveProperty('messageId');
    expect(queued).toMatchObject({ status: 'queued', node: started.node, queued: ['next'] });
    expect(queued).not.toHaveProperty('messageId');
    expect(await (await request(`/conversations/${id}/queue`)).json()).toEqual({
      queued: ['next'],
    });
    await request(`/conversations/${id}/queue`, { method: 'PUT', body: { queued: [] } });
    await request(`/conversations/${id}/stop`, { method: 'POST' });
  });

  it('streams each prompt’s run in order with no gaps, the second on the first one’s history', async () => {
    const { request, start, runOf } = testApi({ hi: [reply('hello'), reply('again')] });
    const id = await start();
    const prompt = async (text: string) => {
      const frames = [];

      for await (const frame of runOf({ id, text })) frames.push(frame);

      return frames;
    };

    const first = await prompt('hi');
    const second = await prompt('and now?');

    for (const frames of [first, second]) {
      const seqs = frames.map(({ entry }) => entry.seq);

      expect(frames.map(({ cursor }) => cursor)).toEqual(seqs.map(String));
      expect(seqs).toEqual(seqs.map((_, index) => (seqs[0] ?? 0) + index));
      expect(kindOf(frames[0]!.entry)).toBe('queue:prompt_started');
      expect(frames.at(-1)?.entry).toMatchObject({ kind: 'event', event: { type: 'done' } });
    }

    expect(second[0]!.entry.seq).toBeGreaterThan(first.at(-1)!.entry.seq);

    const messages = (await (await request(`/conversations/${id}/messages`)).json()) as {
      messages: { role: string; content: string }[];
    };

    expect(messages.messages.map((m) => m.content)).toEqual(['hi', 'hello', 'and now?', 'again']);
  });

  it('streams the whole conversation to a client that joins late, from the start with replay', async () => {
    const { request, start, runOf } = testApi({ hi: [reply('hello')] });
    const id = await start();

    for await (const _frame of runOf({ id, text: 'hi' }));

    const stream = await request(`/conversations/${id}/stream`, {
      method: 'QUERY',
      body: { replay: true },
    });
    const kinds: string[] = [];

    // The stream stays open for later prompts: read until the replayed prompt's done.
    for await (const { entry } of readEntries(stream.body)) {
      kinds.push(kindOf(entry));
      if (kinds.includes('event:done')) break;
    }

    expect(kinds).toEqual([
      'update:session_started',
      // The model the conversation began on is part of its history.
      'update:session_model',
      // The prompt says it started, before the model's events.
      'queue:prompt_started',
      'event:text_delta',
      'event:usage',
      'event:turn_end',
      'update:session_idle',
      'event:done',
    ]);
  });

  it('resumes right after the last entry a client got (Last-Event-ID)', async () => {
    const { request, start, runOf } = testApi({ hi: [reply('hello')] });
    const id = await start();
    const seqs: number[] = [];

    for await (const { entry } of runOf({ id, text: 'hi' })) seqs.push(entry.seq);

    const resumed = await request(`/conversations/${id}/stream`, {
      method: 'QUERY',
      body: {},
      headers: { 'last-event-id': String(seqs[1]) },
    });

    for await (const { entry } of readEntries(resumed.body)) {
      expect(entry.seq).toBe((seqs[1] ?? 0) + 1);
      break;
    }
  });

  it('stops a running prompt, keeping history valid, and queues another sent while it runs', async () => {
    const { request, start, runOf } = testApi({ wait: [calls('block')] });
    const id = await start();
    const kinds: string[] = [];

    for await (const { entry } of runOf({ id, text: 'wait' })) {
      kinds.push(kindOf(entry));

      if (entry.kind === 'event' && entry.event.type === 'tool_call_started') {
        const second = await request(`/conversations/${id}/prompts`, {
          method: 'POST',
          body: { text: 'too soon' },
        });

        expect(await second.json()).toMatchObject({ status: 'queued', queued: ['too soon'] });
        // Taken back out, so only the stopped prompt is in the history below.
        await request(`/conversations/${id}/queue`, { method: 'PUT', body: { queued: [] } });
        expect((await request(`/conversations/${id}/stop`, { method: 'POST' })).status).toBe(204);
      }
    }

    expect(kinds.at(-1)).toBe('event:done');

    const messages = (await (await request(`/conversations/${id}/messages`)).json()) as {
      messages: { role: string }[];
    };

    expect(messages.messages.map((m) => m.role)).toEqual(['user', 'assistant', 'tool']);
  });

  it('sends an approval to a client that answers them, and honours its answer', async () => {
    const { request, start } = testApi({ go: [calls('ask'), reply('done')] });
    const id = await start();
    const stream = await request(`/conversations/${id}/stream`, {
      method: 'QUERY',
      body: { approvals: true },
    });

    await request(`/conversations/${id}/prompts`, { method: 'POST', body: { text: 'go' } });
    let result: unknown;

    for await (const { entry } of readEntries(stream.body)) {
      if (entry.kind === 'approval' && entry.update.type === 'approval_requested') {
        const answered = await request(
          `/conversations/${id}/approvals/${entry.update.request.id}`,
          { method: 'POST', body: { response: { decision: 'skip' } } },
        );

        expect(answered.status).toBe(204);
      }

      if (entry.kind === 'event' && entry.event.type === 'tool_result') {
        result = entry.event.message;
      }

      if (entry.kind === 'event' && entry.event.type === 'done') break;
    }

    expect(result).toMatchObject({ role: 'tool', content: 'skip' });
  });

  it('refuses an approval at once when only a stream that answers none listens', async () => {
    const { start, runOf } = testApi({ go: [calls('ask'), reply('done')] });
    const id = await start();
    const results: string[] = [];

    for await (const { entry } of runOf({ id, text: 'go' })) {
      if (entry.kind === 'event' && entry.event.type === 'tool_result') {
        results.push(entry.event.message.content);
      }
    }

    expect(results[0]).toMatch(/listening/);
  });

  it('refuses an approval when no client is listening, as a headless run does', async () => {
    const { conversations, start } = testApi({ go: [calls('ask'), reply('done')] });
    const id = conversationIdSchema.parse(await start());
    const { events } = await conversations.send({ id, prompt: { text: 'go' } });
    const results: string[] = [];

    for await (const event of events) {
      if (event.type === 'tool_result') results.push(event.message.content);
    }

    expect(results[0]).toMatch(/listening/);
  });

  it('describes a conversation, and switches its model by id, only to one it has', async () => {
    const { request, start } = testApi({});
    const id = await start();
    const switchTo = (body: object) =>
      request(`/conversations/${id}/model`, { method: 'PUT', body });

    expect(await (await request(`/conversations/${id}`)).json()).toMatchObject({
      id,
      workspace: '/work',
      model: { id: FAST_ID, name: 'Astra' },
    });
    expect((await switchTo({ id: DEEP_ID })).status).toBe(204);
    expect(await (await request(`/conversations/${id}`)).json()).toMatchObject({
      model: { id: DEEP_ID, name: 'Astra', adapter: 'azure-openai' },
    });
    // A well-formed id nobody has: the backend's refusal.
    expect(await (await switchTo({ id: UNKNOWN_ID })).json()).toMatchObject({
      error: { code: 'unknown_model' },
    });

    // Not an id at all: a name (both models are called "Astra"), nothing, or a wrong shape.
    for (const body of [{ name: 'Astra' }, {}, { id: 'Astra' }, { id: DEEP_ID.toUpperCase() }]) {
      expect((await switchTo(body)).status, JSON.stringify(body)).toBe(400);
    }

    // The model in use is still the one the last good switch chose.
    expect(await (await request(`/conversations/${id}`)).json()).toMatchObject({
      model: { id: DEEP_ID },
    });
  });

  it('answers a conversation whose storage failed with storage_failed, not a prompt run', async () => {
    const store = new MemoryConversationStore();
    const { request, start, conversations } = testApi({ hi: [reply('hello')] }, store);
    const id = conversationIdSchema.parse(await start());
    const prompt = () =>
      request(`/conversations/${id}/prompts`, { method: 'POST', body: { text: 'hi' } });

    await (await prompt()).text();
    await conversations.get(id).harness.sessions.flushStore();
    store.failWith(new Error('ENOSPC'));
    await (await prompt()).text();
    await conversations.get(id).harness.sessions.flushStore();

    const refused = await prompt();

    expect(refused.status).toBe(507);
    expect(await refused.json()).toMatchObject({ error: { code: 'storage_failed' } });
  });

  it('streams a background task starting and ending, under the session that started it', async () => {
    const { request, start, conversations } = testApi({});
    const id = conversationIdSchema.parse(await start());
    const { harness } = conversations.get(id);
    const stream = await request(`/conversations/${id}/stream`, { method: 'QUERY', body: {} });

    harness.tasks.start({
      command: 'npm test',
      description: 'Tests',
      sessionId: harness.mainSession.id,
      run: async () => ({ exitCode: 0 }),
    });

    const seen: string[] = [];

    for await (const { entry } of readEntries(stream.body)) {
      if (entry.kind === 'task') seen.push(`${entry.sessionId}:${entry.update.type}`);
      if (seen.length === 2) break;
    }

    expect(seen).toEqual([
      `${harness.mainSession.id}:task_started`,
      `${harness.mainSession.id}:task_ended`,
    ]);
  });

  it('closes a conversation: it is gone after', async () => {
    const { request, start } = testApi({});
    const id = await start();

    expect((await request(`/conversations/${id}`, { method: 'DELETE' })).status).toBe(204);
    expect(await (await request(`/conversations/${id}/messages`)).json()).toMatchObject({
      error: { code: 'not_found' },
    });
  });
});

describe('kept conversations over HTTP', () => {
  /** Starts a conversation that has a prompt in it, so it has a title and a history, then closes it. */
  async function kept(api: ReturnType<typeof testApi>) {
    const id = await api.start();

    for await (const _frame of api.runOf({ id, text: 'hi' }));
    await api.conversations.close(conversationIdSchema.parse(id));

    return id;
  }

  const query = (api: ReturnType<typeof testApi>, body: unknown = {}) =>
    api.request('/stored-conversations', { method: 'QUERY', body });

  it('lists the kept conversations, and searches them by title', async () => {
    const api = testApi({ hi: [reply('hello')] }, new MemoryConversationStore());
    const id = await kept(api);

    const all = await query(api);

    expect(all.status).toBe(200);
    expect(await all.json()).toMatchObject({ conversations: [{ id, status: 'closed' }] });

    // The title is the conversation's ("Chat"): a search for it finds it, any other does not.
    const found = (await (await query(api, { search: 'CHAT' })).json()) as { conversations: [] };
    const missed = (await (await query(api, { search: 'nothing like it' })).json()) as {
      conversations: [];
    };

    expect(found.conversations).toHaveLength(1);
    expect(missed.conversations).toEqual([]);
  });

  it('refuses an empty search as bad_request, not as "match everything"', async () => {
    const api = testApi({}, new MemoryConversationStore());
    const response = await query(api, { search: '' });

    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ error: { code: 'bad_request' } });
  });

  it('lists nothing when the host keeps nothing', async () => {
    const api = testApi({});

    expect(await (await query(api)).json()).toEqual({ conversations: [] });
  });

  it('reopens a kept conversation under its own id, with its history', async () => {
    const api = testApi({ hi: [reply('hello')] }, new MemoryConversationStore());
    const id = await kept(api);

    expect((await api.request(`/conversations/${id}/messages`)).status).toBe(404);

    const reopened = await api.request(`/stored-conversations/${id}/reopen`, { method: 'POST' });

    expect(reopened.status).toBe(200);
    expect(await reopened.json()).toEqual({ id });
    expect(await (await api.request(`/conversations/${id}/messages`)).json()).toMatchObject({
      messages: [{ role: 'user' }, { role: 'assistant' }],
    });
  });

  it('answers reopening what is not kept, or is not an id, as not_found', async () => {
    const api = testApi({}, new MemoryConversationStore());

    for (const bad of [UNKNOWN_ID, 'nope', '..']) {
      const response = await api.request(`/stored-conversations/${bad}/reopen`, {
        method: 'POST',
      });

      expect(response.status, bad).toBe(404);
      expect(await response.json(), bad).toMatchObject({ error: { code: 'not_found' } });
    }
  });
});

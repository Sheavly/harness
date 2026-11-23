import { serve } from '@hono/node-server';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { API_ROUTES } from '@sheavly/protocol/api/api.constants';
import { createClient } from '@sheavly/client/client/client.helper';
import { readEntries } from '@sheavly/client/client/entries.helper';
import { promptEntries } from '@sheavly/client/prompt/prompt.helper';
import { modelIdSchema } from '@sheavly/protocol/model/model.validator';
import { reply, testApi } from '../../testing/api.fake.js';
import { collectingLogs } from '../../testing/logs.fake.js';
import { TEST_TOKEN } from '../../testing/testing.constants.js';
import { honoPath } from '../api.utils.js';
import type { HarnessNotice } from '@sheavly/protocol/notice/notice.types';

/** A well-formed id that no conversation's models have. */
const UNKNOWN_ID = '00000000-0000-4000-8000-000000000000';

describe('the API’s guards', () => {
  it('refuses a request without the token, or with a wrong one, before any route runs', async () => {
    const { app, conversations } = testApi({});

    for (const authorization of [
      undefined,
      'Bearer wrong',
      'Basic dGVzdA==',
      `Bearer ${TEST_TOKEN}x`,
    ]) {
      const response = await app.request('/conversations', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          ...(authorization !== undefined && { authorization }),
        },
        body: '{}',
      });

      expect(response.status).toBe(401);
      expect(await response.json()).toEqual({
        error: { code: 'unauthorized', message: 'A valid bearer token is required' },
      });
    }

    await conversations.closeAll();
  });

  it('serves every route of API_ROUTES, at its method and path', async () => {
    const { request, start } = testApi({});
    const id = await start();
    // Closing goes last: the routes after it would find no conversation (still served, but the
    // check reads clearer when each one answers as it would in use).
    const routes = Object.entries(API_ROUTES).sort(
      ([a], [b]) => Number(a === 'closeConversation') - Number(b === 'closeConversation'),
    );

    for (const [name, route] of routes) {
      const path = honoPath(route.path).replace(':id', id).replace(':approval', 'a9');
      const response = await request(path, {
        method: route.method.toUpperCase(),
        // An invalid body (each route's own fields, of the wrong type): a served route refuses it
        // with bad_request rather than run it, and a stream never opens.
        ...('body' in route && {
          body: { text: 1, name: 1, search: 1, response: 1, replay: 'x', messages: 1 },
        }),
      });
      // An unserved route falls through to `notFound`, whose message is "No such route"; a served
      // one answers anything else (a 204, a stream, a bad_request for the invalid body).
      const text = response.status === 204 ? '' : await response.text();

      expect({ name, served: !text.includes('No such route') }).toEqual({ name, served: true });
    }
  });

  it('answers a malformed body as bad_request, and an unknown conversation as not_found', async () => {
    const { request, start } = testApi({});
    const id = await start();

    const both = await request(`/conversations/${id}/prompts`, {
      method: 'POST',
      body: { text: 'a', parts: [{ type: 'text', text: 'a' }] },
    });

    expect(both.status).toBe(400);
    expect(await both.json()).toMatchObject({ error: { code: 'bad_request' } });

    const missing = await request('/conversations/00000000-0000-4000-8000-0000000000ff/messages');

    expect(missing.status).toBe(404);
    expect(await missing.json()).toMatchObject({ error: { code: 'not_found' } });
    expect((await request('/nowhere')).status).toBe(404);
  });

  it('answers an id that cannot be a conversation’s as not found, never as a server failure', async () => {
    const { request } = testApi({});

    // Not a lowercase UUID: nothing could have that id, and none of these may reach a path.
    for (const bad of ['nope', '..', 'C1', '0000', '00000000-0000-4000-8000-0000000000FF']) {
      const response = await request(`/conversations/${bad}/messages`);

      expect(response.status, bad).toBe(404);
      expect(await response.json(), bad).toMatchObject({ error: { code: 'not_found' } });
    }
  });

  it('refuses a picked skill no one has with unknown_skill, and searches the skills', async () => {
    const { request, start } = testApi({});
    const id = await start();
    const response = await request(`/conversations/${id}/prompts`, {
      method: 'POST',
      body: { parts: [{ type: 'skill', name: 'nope' }] },
    });

    expect(response.status).toBe(422);
    expect(await response.json()).toMatchObject({ error: { code: 'unknown_skill' } });

    const skills = (search?: string) =>
      request(`/conversations/${id}/skills`, { method: 'QUERY', body: search ? { search } : {} });

    expect(await (await skills()).json()).toEqual({
      skills: [{ name: 'review', description: 'Reviews.', manualOnly: false, scope: 'project' }],
    });
    expect(await (await skills('REV')).json()).toMatchObject({ skills: [{ name: 'review' }] });
    expect(await (await skills('deploy')).json()).toEqual({ skills: [] });

    const empty = await request(`/conversations/${id}/skills`, {
      method: 'QUERY',
      body: { search: '' },
    });

    expect(empty.status).toBe(400);
  });

  it('ends a prompt whose run fails with a done as failed, and keeps serving', async () => {
    const { logs, entries: logged } = collectingLogs();
    const { request, start, conversations, runOf } = testApi(
      {
        boom: [
          () => {
            throw new Error('model down');
          },
        ],
      },
      undefined,
      undefined,
      logs,
    );
    const id = await start();
    const entries = [];

    // The run ends by itself: a failed run ends with its own `done`, like every other run.
    for await (const { entry } of runOf({ id, text: 'boom' })) entries.push(entry);

    const frames = JSON.stringify(entries);

    expect(frames).toContain('"type":"run_failed"');
    expect(frames).toContain('"type":"done"');
    expect(frames).toContain('"reason":"failed"');
    expect(frames).toContain('"lastOutcome":"failed"');
    // Logged as the run that nobody awaits throws, just after its `done` reached the stream.
    await vi.waitFor(() => {
      expect(logged).toHaveLength(1);
      expect(logged[0]).toMatchObject({
        event: 'prompt.failed',
        conversationId: id,
        error: { message: 'model down' },
      });
    });
    expect((await request(`/conversations/${id}/messages`)).status).toBe(200);

    await conversations.closeAll();
  });

  it('answers an approval no one is waiting for with unknown_approval', async () => {
    const { request, start } = testApi({});
    const id = await start();
    const response = await request(`/conversations/${id}/approvals/a9`, {
      method: 'POST',
      body: { response: { decision: 'approve' } },
    });

    expect(response.status).toBe(404);
    expect(await response.json()).toMatchObject({ error: { code: 'unknown_approval' } });
  });
});

describe('over real HTTP, with the client UIs use', () => {
  let close: (() => Promise<void>) | undefined;

  afterEach(async () => {
    await close?.();
    close = undefined;
  });

  /** Listens on a free port on 127.0.0.1, as `serve.ts` does. */
  async function listen() {
    const { app, conversations } = testApi({
      hi: [reply('hello')],
      telemetry: [
        () => [
          { type: 'text_delta', text: 'measured' },
          {
            type: 'done',
            stopReason: 'end_turn',
            usage: {
              tokens: {
                inputTokens: 90,
                outputTokens: 10,
                cacheReadTokens: 0,
                cacheWriteTokens: 0,
              },
            },
          },
        ],
        reply('finished'),
      ],
    });
    const server = await new Promise<ReturnType<typeof serve>>((resolve) => {
      const started = serve({ fetch: app.fetch, hostname: '127.0.0.1', port: 0 }, () =>
        resolve(started),
      );
    });

    close = async () => {
      await conversations.closeAll();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    };

    return `http://127.0.0.1:${String((server.address() as AddressInfo).port)}`;
  }

  it('starts a conversation, streams a prompt over QUERY and SSE, and reads the history', async () => {
    const url = await listen();
    const client = createClient({ url, token: TEST_TOKEN });
    const { id } = await client.call('startConversation', { body: {} });

    // The stream is opened first: it sees the prompt's entries as they happen, over the socket.
    const stream = await client.open('streamConversation', { id, body: {} });
    const answered: string[] = [];
    const streamed: string[] = [];

    for await (const entry of promptEntries({ client, id, prompt: { text: 'hi' } })) {
      if (entry.kind === 'event' && entry.event.type === 'text_delta') {
        answered.push(entry.event.text);
      }
    }

    for await (const { entry } of readEntries(stream)) {
      streamed.push(entry.kind === 'event' ? entry.event.type : entry.update.type);
      if (streamed.includes('done')) break;
    }

    const history = await client.call('getMessages', { id });

    expect(answered).toEqual(['hello']);
    expect(streamed).toContain('text_delta');
    expect(
      history.messages.flatMap((message) => ('content' in message ? [message.content] : [])),
    ).toEqual(['hi', 'hello']);
  });

  it('serves structured notices to another UI through the ordinary client stream', async () => {
    const url = await listen();
    const editor = createClient({ url, token: TEST_TOKEN });
    const viewer = createClient({ url, token: TEST_TOKEN });
    const { id } = await editor.call('startConversation', { body: {} });

    for await (const _entry of promptEntries({
      client: editor,
      id,
      prompt: { text: 'telemetry' },
    }));

    const stream = await viewer.open('streamConversation', { id, body: { replay: false } });
    const sent: HarnessNotice[] = [];
    const observed: HarnessNotice[] = [];

    for await (const entry of promptEntries({
      client: editor,
      id,
      prompt: { text: 'telemetry' },
    })) {
      if (entry.kind === 'event' && entry.event.type === 'harness_notice') {
        sent.push(entry.event.notice);
      }
    }

    for await (const { entry } of readEntries(stream)) {
      if (entry.kind !== 'event') continue;

      if (entry.event.type === 'harness_notice') observed.push(entry.event.notice);
      if (entry.event.type === 'done') break;
    }

    expect(sent).toEqual([{ kind: 'context-usage', context: { used: 100 } }]);
    expect(observed).toEqual(sent);
    const { messages } = await editor.call('getMessages', { id });

    expect(JSON.stringify(messages)).not.toContain('context-usage');
  });

  it('lets a second UI find a conversation another started, and follow it', async () => {
    const url = await listen();
    const editor = createClient({ url, token: TEST_TOKEN });
    const agentWindow = createClient({ url, token: TEST_TOKEN });
    const { id } = await editor.call('startConversation', { body: {} });
    const listed = await agentWindow.call('listConversations', {});
    const found = listed.conversations.find((conversation) => conversation.id === id);

    if (!found) throw new Error('the agent window doesn’t see the editor’s conversation');
    expect(found).toMatchObject({ id, running: false });

    // The agent window follows the main session; the editor sends the prompt.
    const stream = await agentWindow.open('streamConversation', {
      id,
      body: { session: found.session },
    });

    for await (const _entry of promptEntries({ client: editor, id, prompt: { text: 'hi' } }));

    const seen: string[] = [];

    for await (const { entry } of readEntries(stream)) {
      if (entry.kind === 'event' && entry.event.type === 'text_delta') seen.push(entry.event.text);
      if (entry.kind === 'event' && entry.event.type === 'done') break;
    }

    expect(seen).toEqual(['hello']);
  });

  it('refuses a request with the backend’s code, and an answer off the contract loudly', async () => {
    const url = await listen();
    const client = createClient({ url, token: TEST_TOKEN });
    const { id } = await client.call('startConversation', { body: {} });

    await expect(
      client.send('switchModel', { id, body: { id: modelIdSchema.parse(UNKNOWN_ID) } }),
    ).rejects.toMatchObject({
      name: 'RefusedError',
      status: 422,
      code: 'unknown_model',
    });
    // A backend that answers something else than the route's schema says: caught at the client.
    const drifted = createClient({
      url,
      token: TEST_TOKEN,
      fetch: async () => Response.json({ messages: 'not a list' }),
    });

    await expect(drifted.call('getMessages', { id })).rejects.toMatchObject({
      name: 'AnswerError',
    });
  });

  it('refuses a request without the token over the network too', async () => {
    const url = await listen();
    const response = await fetch(`${url}/conversations`, { method: 'POST', body: '{}' });

    expect(response.status).toBe(401);
  });
});

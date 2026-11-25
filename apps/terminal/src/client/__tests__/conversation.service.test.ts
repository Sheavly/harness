import { describe, expect, it } from 'vitest';
import { fakeServer } from '@sheavly/client/testing/fake-server.fake';
import { callIdSchema, messageIdSchema } from '@sheavly/protocol/message/message.validator';
import { modelIdSchema } from '@sheavly/protocol/model/model.validator';
import { sessionIdSchema } from '@sheavly/protocol/session/session.validator';
import type { StreamEntry } from '@sheavly/protocol/stream/stream.types';
import { RemoteConversation } from '../conversation.service.js';
import {
  FAKE_ID as ID,
  FAKE_MAIN as MAIN,
  doneAt,
  openOnFake,
  sentEntries,
  textAt,
} from '../../testing/remote-conversation.fake.js';
import { promptStarted } from '../../testing/live-feed.fake.js';
import { queuedAnswer, startedAnswer } from '../../chat/testing/prompt-answers.fake.js';

/** Two models' ids: the backend has `DEEP` and not `OTHER`. */
const DEEP = '9d2c7e10-6a4b-4f38-b1e5-5c0a8d3f2b71';
const OTHER = '00000000-0000-4000-8000-000000000000';
const MESSAGE = '00000000-0000-4000-8000-0000000000aa';

describe('RemoteConversation', () => {
  it('reopens a saved conversation without creating a new one', async () => {
    const server = fakeServer({ reopenConversation: () => ({ id: ID }) });
    const conversation = await RemoteConversation.reopen({
      backend: {
        url: 'http://backend.test',
        token: 't',
        stop: async () => undefined,
        fetch: server.fetch,
      },
      id: ID,
    });

    expect(conversation.id).toBe(ID);
    expect(server.calls.map((call) => call.name)).toEqual(['reopenConversation']);
    expect(server.calls[0]?.call).toEqual({ params: { id: ID } });
  });

  it('sends a prompt and yields its run from its start to its done, then reads the history', async () => {
    const { conversation, server } = await openOnFake({
      runs: [[textAt(1, 'hello'), doneAt(2)]],
      handlers: { getMessages: () => ({ messages: [{ role: 'user', content: 'hi' }] }) },
    });

    expect((await sentEntries({ conversation })).map((entry) => entry.seq)).toEqual([0, 1, 2]);
    expect(await conversation.messages()).toEqual([{ role: 'user', content: 'hi' }]);
    expect(server.calls.find(({ name }) => name === 'sendPrompt')?.call).toEqual({
      params: { id: ID },
      body: { text: 'hi' },
    });
  });

  it('follows the stream before it sends, so no entry of the run is missed', async () => {
    const { conversation, server } = await openOnFake({ runs: [[doneAt(1)]] });

    await sentEntries({ conversation });

    expect(server.calls.map(({ name }) => name)).toEqual([
      'startConversation',
      'streamConversation',
      'sendPrompt',
    ]);
  });

  it('yields a queued prompt’s run only once the backend starts it, after the run before it', async () => {
    const { conversation, feed } = await openOnFake({
      handlers: {
        sendPrompt: () => {
          // Another run goes: the line waits in the backend's queue, and starts when it ends.
          setTimeout(() => {
            feed.publish(textAt(1, 'the run before'), doneAt(2));
            feed.publish(promptStarted({ seq: 3, text: 'hi' }), textAt(4, 'mine'), doneAt(5));
          }, 0);

          return queuedAnswer(['hi']);
        },
      },
    });

    expect((await sentEntries({ conversation })).map((entry) => entry.seq)).toEqual([3, 4, 5]);
  });

  it('throws for a queued prompt the backend could not start', async () => {
    const { conversation, feed } = await openOnFake({
      handlers: {
        sendPrompt: () => {
          setTimeout(() =>
            feed.publish({
              seq: 1,
              at: 0,
              sessionId: MAIN,
              kind: 'queue',
              update: { type: 'prompt_refused', text: 'hi', error: 'No skill /nope', queued: [] },
            }),
          );

          return queuedAnswer(['hi']);
        },
      },
    });

    await expect(sentEntries({ conversation })).rejects.toMatchObject({
      name: 'PromptRefusedError',
      message: 'No skill /nope',
    });
  });

  it('submits a line and answers what the backend did with it, without reading any stream', async () => {
    const { conversation, server } = await openOnFake({
      handlers: { sendPrompt: () => queuedAnswer(['first', 'hi']) },
    });

    expect(await conversation.submit('hi')).toEqual(queuedAnswer(['first', 'hi']));
    expect(server.calls.map(({ name }) => name)).toEqual(['startConversation', 'sendPrompt']);
  });

  it('throws the backend’s refusal of a submitted line, with its code', async () => {
    const { conversation } = await openOnFake({
      handlers: { sendPrompt: () => ({ refuse: { status: 409, code: 'cannot_queue' } }) },
    });

    await expect(conversation.submit('hi')).rejects.toMatchObject({
      name: 'RefusedError',
      code: 'cannot_queue',
    });
  });

  it('reports a failed main run after partial text instead of silently becoming ready', async () => {
    const { conversation } = await openOnFake({
      runs: [[textAt(1, 'Now the design doc.'), doneAt(2, 'failed')]],
    });

    await expect(sentEntries({ conversation })).rejects.toThrow(
      'The model run failed before completing',
    );
  });

  it('throws a main run_failed with its originating message id', async () => {
    const failed: StreamEntry = {
      seq: 1,
      at: 0,
      sessionId: MAIN,
      messageId: messageIdSchema.parse(MESSAGE),
      kind: 'event',
      event: {
        seq: 1,
        type: 'run_failed',
        error: 'boom',
        session: { id: MAIN, rootId: MAIN, depth: 1 },
      },
    };
    const { conversation } = await openOnFake({ runs: [[failed, doneAt(2, 'failed')]] });

    await expect(sentEntries({ conversation })).rejects.toThrow(`[message ${MESSAGE}] boom`);
  });

  it('does not mistake a failed sub-agent for a failed main run', async () => {
    const child = sessionIdSchema.parse('child');
    const { conversation } = await openOnFake({
      runs: [
        [
          {
            seq: 1,
            at: 0,
            sessionId: child,
            kind: 'update',
            update: {
              type: 'session_idle',
              session: {
                id: child,
                rootId: MAIN,
                parentId: MAIN,
                startedByCall: callIdSchema.parse('child-call'),
                depth: 2,
                title: 'Child',
                state: 'idle',
                startedAt: 0,
                lastOutcome: 'failed',
              },
            },
          },
          doneAt(2),
        ],
      ],
    });

    expect((await sentEntries({ conversation })).at(-1)).toMatchObject({
      event: { reason: 'completed' },
    });
  });

  it('asks the backend to stop the prompt when its signal aborts, and still yields its done', async () => {
    const stop = new AbortController();
    const { conversation, server, feed } = await openOnFake({
      handlers: {
        sendPrompt: () => {
          feed.publish(promptStarted({ seq: 0, text: 'hi' }), textAt(1, 'working'));

          return startedAnswer();
        },
        // The backend answers the stop with the prompt's `done`, as the real one does.
        stopPrompt: () => {
          setTimeout(() => feed.publish(doneAt(2, 'interrupted')), 10);
        },
      },
    });
    const seen: StreamEntry[] = [];

    for await (const entry of conversation.send({ text: 'hi', signal: stop.signal })) {
      seen.push(entry);
      if (entry.seq === 1) stop.abort();
    }

    expect(seen.at(-1)).toMatchObject({ event: { reason: 'interrupted' } });
    expect(server.calls.map(({ name }) => name)).toContain('stopPrompt');
  });

  it('follows every run on the live stream once the backend accepted it, until its signal aborts', async () => {
    const { conversation, feed } = await openOnFake({});
    const stop = new AbortController();
    const heard: number[] = [];
    const { ended } = await conversation.follow({
      onEntry: (entry) => {
        heard.push(entry.seq);
        if (entry.seq === 2) stop.abort();
      },
      signal: stop.signal,
    });

    // A run the backend started itself: no prompt of this client carries it.
    feed.publish(textAt(1, 'woken'), doneAt(2));
    await ended;

    expect(heard).toEqual([1, 2]);
  });

  it('switches to a model by id, and says false for one the backend hasn’t, without throwing', async () => {
    const { conversation } = await openOnFake({
      handlers: {
        switchModel: ({ body }) =>
          (body as { id: string }).id === DEEP
            ? undefined
            : { refuse: { status: 422, code: 'unknown_model' } },
      },
    });

    expect(await conversation.useModel(modelIdSchema.parse(DEEP))).toBe(true);
    expect(await conversation.useModel(modelIdSchema.parse(OTHER))).toBe(false);
  });

  it('sends the id and nothing else: the label is never what is switched by', async () => {
    const { conversation, server } = await openOnFake({
      handlers: { switchModel: () => undefined },
    });

    await conversation.useModel(modelIdSchema.parse(DEEP));
    expect(server.calls.find(({ name }) => name === 'switchModel')?.call.body).toEqual({
      id: DEEP,
    });
  });

  it('throws any other refusal, with the backend’s code', async () => {
    const { conversation } = await openOnFake({
      handlers: { switchModel: () => ({ refuse: { status: 404, code: 'not_found' } }) },
    });

    await expect(conversation.useModel(modelIdSchema.parse(DEEP))).rejects.toMatchObject({
      name: 'RefusedError',
      code: 'not_found',
    });
  });

  it('searches skills with a typed body, and lists them all without one', async () => {
    const { conversation, server } = await openOnFake({
      handlers: { querySkills: () => ({ skills: [] }) },
    });

    await conversation.skills('rev');
    await conversation.skills();

    expect(
      server.calls.filter(({ name }) => name === 'querySkills').map(({ call }) => call.body),
    ).toEqual([{ search: 'rev' }, {}]);
  });
});

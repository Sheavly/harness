import { collect } from '@sheavly/testing/fetch/fake-fetch.fake';
import { useFixedClock } from '@sheavly/testing/clock/fixed-clock.fake';
import { describe, expect, it } from 'vitest';
import { conversationIdSchema } from '@sheavly/protocol/server/server.validator';
import { modelIdSchema } from '@sheavly/protocol/model/model.validator';
import { ConversationsError } from '../../errors/conversations.errors.js';
import {
  blockedThenNext,
  say,
  scriptedConversations as setup,
  stopWhenBlocked,
} from '../../testing/conversations.fake.js';
import { DEEP_ID, FAST_ID } from '../../testing/run.fake.js';

describe('Conversations', () => {
  const clock = useFixedClock();

  it('keeps each conversation apart, each continuing its own history', async () => {
    const { conversations, sent } = setup({ replies: [say('one'), say('two')] });
    const a = await conversations.start();
    const b = await conversations.start({ messages: [{ role: 'user', content: 'earlier' }] });

    await collect((await conversations.send({ id: a, prompt: { text: 'hi a' } })).events);
    await collect((await conversations.send({ id: b, prompt: { text: 'hi b' } })).events);

    expect(a).not.toBe(b);
    expect(conversations.messages(a).flatMap((m) => ('content' in m ? [m.content] : []))).toEqual([
      'hi a',
      'one',
    ]);
    expect(sent.at(-1)?.map((m) => m.content)).toEqual(['earlier', 'hi b']);
  });

  it('lists every live conversation, oldest first, with whether a prompt runs', async () => {
    const { conversations } = setup({ replies: [say('one')] });
    const a = await conversations.start();
    const b = await conversations.start();
    const { events } = await conversations.send({ id: b, prompt: { text: 'go' } });

    expect(conversations.list()).toEqual([
      expect.objectContaining({ id: a, title: 'Chat', running: false }),
      expect.objectContaining({ id: b, title: 'Chat', running: true }),
    ]);
    await collect(events);
    await conversations.close(a);
    expect(conversations.list().map(({ id, running }) => ({ id, running }))).toEqual([
      { id: b, running: false },
    ]);
    expect(conversations.list()[0]?.session).toBe(conversations.get(b).harness.mainSession.id);
  });

  it('describes a conversation’s run, and switches its model to one it has', async () => {
    const { conversations } = setup({ replies: [] });
    const id = await conversations.start();

    expect(await conversations.details(id)).toMatchObject({
      id,
      title: 'Chat',
      running: false,
      workspace: '/work',
      model: { id: FAST_ID },
      models: [{ id: FAST_ID }, { id: DEEP_ID }],
      permissionMode: 'ask',
    });
    await conversations.useModel({ id, modelId: DEEP_ID });
    expect((await conversations.details(id)).model).toEqual({
      id: DEEP_ID,
      name: 'Astra',
      adapter: 'azure-openai',
      model: 'gpt-5',
    });
  });

  it('switches by id only: models may share a label, and a label is not an id', async () => {
    const { conversations } = setup({ replies: [] });
    const id = await conversations.start();
    const unknown = modelIdSchema.parse('00000000-0000-4000-8000-000000000000');

    // Both are "Astra": the label can't say which, the id can.
    expect((await conversations.details(id)).models.map((model) => model.name)).toEqual([
      'Astra',
      'Astra',
    ]);
    await conversations.useModel({ id, modelId: DEEP_ID });
    expect((await conversations.details(id)).model.id).toBe(DEEP_ID);
    await conversations.useModel({ id, modelId: FAST_ID });
    expect((await conversations.details(id)).model.id).toBe(FAST_ID);
    await expect(conversations.useModel({ id, modelId: unknown })).rejects.toMatchObject({
      reason: 'unknown_model',
    });
    // The refusal names the id it was given, not a label.
    await expect(conversations.useModel({ id, modelId: unknown })).rejects.toThrow(unknown);
    expect((await conversations.details(id)).model.id).toBe(FAST_ID);
  });

  it('records the model a conversation starts on and each switch on its main session', async () => {
    const { conversations } = setup({ replies: [] });
    const id = await conversations.start();
    const main = conversations.get(id).harness.mainSession.id;
    const sessions = () => conversations.get(id).harness.sessions;

    expect(sessions().get(main)?.modelId).toBe(FAST_ID);

    await conversations.useModel({ id, modelId: DEEP_ID });
    expect(sessions().get(main)?.modelId).toBe(DEEP_ID);

    // A model the conversation does not have is refused, and records nothing.
    await expect(
      conversations.useModel({
        id,
        modelId: modelIdSchema.parse('00000000-0000-4000-8000-000000000000'),
      }),
    ).rejects.toThrow();
    expect(sessions().get(main)?.modelId).toBe(DEEP_ID);
  });

  it('switches only its own conversation: another running one keeps its model', async () => {
    const { conversations } = setup({ replies: [] });
    const a = await conversations.start();
    const b = await conversations.start();
    const modelOf = (id: typeof a) => {
      const live = conversations.get(id);

      return live.harness.sessions.get(live.harness.mainSession.id)?.modelId;
    };

    await conversations.useModel({ id: a, modelId: DEEP_ID });

    expect(modelOf(a)).toBe(DEEP_ID);
    expect(modelOf(b)).toBe(FAST_ID);
    expect((await conversations.details(b)).model.id).toBe(FAST_ID);
  });

  it('runs a prompt’s skills, keeping what the user typed on the history', async () => {
    const { conversations, sent } = setup({ replies: [say('ok')], withSkills: true });
    const id = await conversations.start();
    const prompt = await conversations.send({ id, prompt: { text: 'look /review' } });

    await collect(prompt.events);

    expect(prompt.text).toBe('[review]\nlook /review');
    expect(sent[0]?.[0]).toMatchObject({
      role: 'user',
      content: '[review]\nlook /review',
      parts: [{ type: 'skill', name: 'review' }],
    });
    expect(await conversations.skills({ id })).toHaveLength(1);
    // A search narrows by name or description, ignoring case; one that matches nothing lists none.
    expect(await conversations.skills({ id, search: 'REV' })).toHaveLength(1);
    expect(await conversations.skills({ id, search: 'reviews' })).toHaveLength(1);
    expect(await conversations.skills({ id, search: 'deploy' })).toEqual([]);
  });

  it('refuses a picked skill no one has before the prompt starts', async () => {
    const { conversations, sent } = setup({ replies: [say('never')], withSkills: true });
    const id = await conversations.start();

    await expect(
      conversations.send({ id, prompt: { parts: [{ type: 'skill', name: 'nope' }] } }),
    ).rejects.toMatchObject({ reason: 'unknown_skill' });
    expect(sent).toEqual([]);
  });

  it('sends text as it is, and has no skills, when the conversation has none', async () => {
    const { conversations, sent } = setup({ replies: [say('ok')] });
    const id = await conversations.start();

    await collect((await conversations.send({ id, prompt: { text: 'plain /review' } })).events);

    expect(sent[0]?.[0]).toMatchObject({ role: 'user', content: 'plain /review' });
    expect(await conversations.skills({ id })).toEqual([]);
  });

  it('stamps the user’s prompt with when it was sent, and keeps it on the history', async () => {
    const { conversations } = setup({ replies: [say('ok')] });
    const id = await conversations.start();
    const sentAt = clock.at;

    clock.advance(2_000);
    await collect((await conversations.send({ id, prompt: { text: 'hello' } })).events);

    expect(conversations.messages(id)[0]).toMatchObject({
      role: 'user',
      content: 'hello',
      at: sentAt + 2_000,
    });
  });

  it('stops a running prompt and keeps history valid; refuses a second while one runs', async () => {
    const { conversations } = setup({ replies: blockedThenNext() });
    const id = await conversations.start();
    const stopped = await stopWhenBlocked({
      conversations,
      id,
      stop: async () => {
        await expect(conversations.send({ id, prompt: { text: 'too soon' } })).rejects.toThrow(
          expect.objectContaining({ reason: 'session_running' }),
        );
        conversations.stop(id);
      },
    });

    expect(stopped).toEqual({ last: 'done', roles: ['user', 'assistant', 'tool'] });
  });

  it('closes a conversation, disposing what the app opened, and forgets it', async () => {
    const { conversations, disposed } = setup({ replies: [say('ok')] });
    const id = await conversations.start();

    await conversations.close(id);

    expect(disposed).toEqual(['disposed']);
    expect(() => conversations.messages(id)).toThrow(ConversationsError);
    expect(() =>
      conversations.get(conversationIdSchema.parse('00000000-0000-4000-8000-0000000000ff')),
    ).toThrow(expect.objectContaining({ reason: 'not_found' }));
  });

  it('closes every conversation at once, for a host shutting down', async () => {
    const { conversations, disposed } = setup({ replies: [say('ok')] });

    await conversations.start();
    await conversations.start();
    await conversations.closeAll();

    expect(disposed).toEqual(['disposed', 'disposed']);
  });
});

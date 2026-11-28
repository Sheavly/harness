import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { SessionRegistry } from '../sessions.service.js';
import { STARTED_BY } from '../../testing/sessions.fake.js';
import type { ItemEvent } from '@sheavly/protocol/item/item.types';
import { itemIdSchema } from '@sheavly/protocol/item/item.validator';
import { messageIdSchema } from '@sheavly/protocol/message/message.validator';
import type { SessionId } from '@sheavly/protocol/session/session.types';
import { sessionIdSchema } from '@sheavly/protocol/session/session.validator';
import type { StreamEntry } from '@sheavly/protocol/stream/stream.types';
import type { PublishedItem } from '../sessions.types.js';

const MESSAGE_ID = messageIdSchema.parse('0f8fad5b-d9cb-469f-a165-70867728950e');

function messageStarted(): ItemEvent {
  return { type: 'item_started', itemId: itemIdSchema.parse(randomUUID()), kind: 'message' };
}

function delta(text: string): ItemEvent {
  return {
    type: 'item_delta',
    itemId: itemIdSchema.parse(randomUUID()),
    offset: 0,
    text,
  };
}

function startChildOf(params: { sessions: SessionRegistry; parentId: SessionId }) {
  return params.sessions.startChild({
    parentId: params.parentId,
    startedByCall: STARTED_BY,
    title: 'Child',
  });
}

/** A registry with a main session and a child of it, and every item its listener has heard. */
function worldWithChild() {
  const sessions = new SessionRegistry();
  const main = sessions.startMain({ title: 'Main' });
  const child = startChildOf({ sessions, parentId: main.id });
  const heard: PublishedItem[] = [];

  sessions.subscribeItems((item) => heard.push(item));

  return { sessions, main, child, heard };
}

describe("SessionRegistry's item path", () => {
  it('tells subscribers each item in the order it was published, with its session id', () => {
    const { sessions, main, child, heard } = worldWithChild();
    const [first, second, third] = [messageStarted(), delta('a'), delta('b')];

    sessions.publishItem({ sessionId: main.id, event: first });
    sessions.publishItem({ sessionId: child.id, event: second });
    sessions.publishItem({ sessionId: main.id, event: third });

    expect(heard).toEqual([
      { sessionId: main.id, event: first },
      { sessionId: child.id, event: second },
      { sessionId: main.id, event: third },
    ]);
  });

  it('adds the user message the session is associated with, and none when there is none', () => {
    const sessions = new SessionRegistry();
    const main = sessions.startMain({ title: 'Main' });
    const heard: PublishedItem[] = [];
    const event = delta('a');

    sessions.subscribeItems((item) => heard.push(item));
    sessions.publishItem({ sessionId: main.id, event });
    sessions.setMessage({ sessionId: main.id, messageId: MESSAGE_ID });
    sessions.publishItem({ sessionId: main.id, event });

    expect(heard).toEqual([
      { sessionId: main.id, event },
      { sessionId: main.id, messageId: MESSAGE_ID, event },
    ]);
    expect(heard[0]?.messageId).toBeUndefined();
  });

  it('gives a sub-agent the message of the prompt that started it', () => {
    const sessions = new SessionRegistry();
    const main = sessions.startMain({ title: 'Main' });

    sessions.setMessage({ sessionId: main.id, messageId: MESSAGE_ID });

    const child = startChildOf({ sessions, parentId: main.id });
    const heard: PublishedItem[] = [];

    sessions.subscribeItems((item) => heard.push(item));
    sessions.publishItem({ sessionId: child.id, event: delta('a') });

    expect(heard.map((item) => item.messageId)).toEqual([MESSAGE_ID]);
  });

  it('tells a listener nothing more once it has unsubscribed', () => {
    const sessions = new SessionRegistry();
    const main = sessions.startMain({ title: 'Main' });
    const heard: string[] = [];
    const stop = sessions.subscribeItems((item) => heard.push(item.event.type));

    sessions.publishItem({ sessionId: main.id, event: messageStarted() });
    stop();
    sessions.publishItem({ sessionId: main.id, event: delta('a') });

    expect(heard).toEqual(['item_started']);
  });

  it('keeps a throwing listener from the publisher and the other listeners, and still reports it', async () => {
    const sessions = new SessionRegistry();
    const main = sessions.startMain({ title: 'Main' });
    const heard: string[] = [];
    const uncaught: unknown[] = [];
    const onUncaught = (error: unknown) => uncaught.push(error);

    process.on('uncaughtException', onUncaught);
    sessions.subscribeItems(() => {
      throw new Error('broken view');
    });
    sessions.subscribeItems((item) => heard.push(item.event.type));

    expect(() =>
      sessions.publishItem({ sessionId: main.id, event: messageStarted() }),
    ).not.toThrow();
    expect(heard).toEqual(['item_started']);
    await new Promise((resolve) => setTimeout(resolve, 0));
    process.off('uncaughtException', onUncaught);
    expect(uncaught).toEqual([new Error('broken view')]);
  });

  it('drops an item for an unknown session and tells no one, where publish refuses an event', () => {
    const sessions = new SessionRegistry();
    const unknown = sessionIdSchema.parse(randomUUID());
    const heard: PublishedItem[] = [];

    sessions.subscribeItems((item) => heard.push(item));

    expect(() =>
      sessions.publish({ sessionId: unknown, event: { seq: 0, type: 'text_delta', text: 'a' } }),
    ).toThrow(expect.objectContaining({ reason: 'unknown_session', sessionId: unknown }));
    expect(() => sessions.publishItem({ sessionId: unknown, event: delta('a') })).not.toThrow();
    expect(heard).toEqual([]);
  });

  it('drops an item for a released session, and goes on telling the others', () => {
    const { sessions, main, child, heard } = worldWithChild();

    sessions.end({ id: child.id, state: 'completed' });
    sessions.release(child.id);

    expect(() => sessions.publishItem({ sessionId: child.id, event: delta('a') })).not.toThrow();
    sessions.publishItem({ sessionId: main.id, event: delta('b') });

    expect(heard.map((item) => item.sessionId)).toEqual([main.id]);
  });

  it('hands every listener a frozen copy: the run’s own objects cannot be changed through it', () => {
    const sessions = new SessionRegistry();
    const main = sessions.startMain({ title: 'Main' });
    const input = { path: 'a.ts', lines: [1, 2] };
    const heard: PublishedItem[][] = [[], []];
    const event: ItemEvent = {
      type: 'item_completed',
      item: {
        kind: 'tool_call',
        id: itemIdSchema.parse(randomUUID()),
        name: 'read_file',
        description: 'reading',
        turn: 1,
        input,
        reason: 'completed',
      },
    };

    heard.forEach((list) => sessions.subscribeItems((item) => list.push(item)));
    sessions.publishItem({ sessionId: main.id, event });

    const [first] = heard[0] ?? [];
    const told = first?.event.type === 'item_completed' ? first.event.item : undefined;

    expect(Object.isFrozen(first)).toBe(true);
    expect(told?.kind === 'tool_call' ? told.input : undefined).toEqual(input);
    expect(told?.kind === 'tool_call' ? told.input : undefined).not.toBe(input);
    expect(Object.isFrozen(told?.kind === 'tool_call' ? told.input : undefined)).toBe(true);
    expect(Object.isFrozen(input)).toBe(false);
    // Both heard the same copy, which nobody can change.
    expect(heard[0]?.[0]).toBe(heard[1]?.[0]);
  });

  it('never puts an item in the combined stream, its log or its numbering', () => {
    const sessions = new SessionRegistry();
    const main = sessions.startMain({ title: 'Main' });
    const live: StreamEntry[] = [];

    sessions.subscribeEntries((entry) => live.push(entry));

    const before = { next: sessions.nextSeq(), retained: sessions.retainedEntries };

    sessions.publishItem({ sessionId: main.id, event: messageStarted() });
    sessions.publishItem({ sessionId: main.id, event: delta('a') });

    const replayed: StreamEntry[] = [];

    sessions.subscribeEntries((entry) => replayed.push(entry), { replay: true });

    expect(live).toEqual([]);
    expect({ next: sessions.nextSeq(), retained: sessions.retainedEntries }).toEqual(before);
    expect(replayed.map((entry) => entry.seq)).toEqual([0]);
    expect(sessions.lastTokens(main.id)).toBeUndefined();
  });
});

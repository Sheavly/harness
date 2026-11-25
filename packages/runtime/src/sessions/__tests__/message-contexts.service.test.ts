import { describe, expect, it } from 'vitest';
import { SessionRegistry } from '../sessions.service.js';
import { readStoredLog } from '../stored-log.helper.js';
import { messageIdSchema, callIdSchema } from '@sheavly/protocol/message/message.validator';
import type { SessionId } from '@sheavly/protocol/session/session.types';
import { sessionIdSchema } from '@sheavly/protocol/session/session.validator';
import type { StreamEntry } from '@sheavly/protocol/stream/stream.types';
import { ENTRY_TAIL_SIZE } from '../sessions.constants.js';

const first = messageIdSchema.parse('00000000-0000-4000-8000-000000000001');
const second = messageIdSchema.parse('00000000-0000-4000-8000-000000000002');

/** A sub-agent that `parent` starts, as a tool call `launch` does. */
const launchChild = (params: { sessions: SessionRegistry; parent: SessionId }) =>
  params.sessions.startChild({
    parentId: params.parent,
    startedByCall: callIdSchema.parse('launch'),
    title: 'Child',
  });

describe('the message a session answers', () => {
  it('is none before a prompt, the prompt’s message after it, and moves on with the next; a sub-agent keeps the one it started under', () => {
    const sessions = new SessionRegistry();
    const main = sessions.startMain({ title: 'Chat' });

    expect(sessions.messageOf(main.id)).toBeUndefined();

    sessions.setMessage({ sessionId: main.id, messageId: first });

    expect(sessions.messageOf(main.id)).toBe(first);

    const child = launchChild({ sessions, parent: main.id });

    expect(sessions.messageOf(child.id)).toBe(first);

    sessions.setMessage({ sessionId: main.id, messageId: second });

    expect(sessions.messageOf(main.id)).toBe(second);
    expect(sessions.messageOf(child.id)).toBe(first);
    // A session the registry never had answers no message.
    expect(sessions.messageOf(sessionIdSchema.parse('nobody'))).toBeUndefined();
  });
});

describe('session message correlation', () => {
  it('keeps a child linked to its starting message while the main session moves on', () => {
    const sessions = new SessionRegistry();
    const main = sessions.startMain({ title: 'Chat' });
    const entries: StreamEntry[] = [];

    sessions.subscribeEntries((entry) => entries.push(entry));
    sessions.setMessage({ sessionId: main.id, messageId: first });
    const child = launchChild({ sessions, parent: main.id });

    sessions.setMessage({ sessionId: main.id, messageId: second });
    sessions.publish({
      sessionId: child.id,
      event: { seq: 0, type: 'run_failed', error: 'Late child failure', session: child },
    });
    sessions.publish({
      sessionId: main.id,
      event: { seq: 0, type: 'run_failed', error: 'Main failure', session: main },
    });

    expect(entries.at(-2)?.messageId).toBe(first);
    expect(entries.at(-1)?.messageId).toBe(second);
    expect(entries[0]?.messageId).toBe(first);
  });

  it('restores correlation from the full stored stream, not just its bounded tail', async () => {
    const source = new SessionRegistry();
    const main = source.startMain({ title: 'Chat' });
    const entries: StreamEntry[] = [];

    source.subscribeEntries((entry) => entries.push(entry), { replay: true });
    const child = source.startChild({
      parentId: main.id,
      startedByCall: callIdSchema.parse('early-child'),
      title: 'Child',
    });

    source.setMessage({ sessionId: main.id, messageId: first });
    source.idle({ id: main.id, outcome: 'failed' });

    for (let i = 0; i < ENTRY_TAIL_SIZE; i++) {
      source.publish({
        sessionId: child.id,
        event: { seq: i, type: 'usage', usage: { tokens: null } },
      });
    }

    const resume = await readStoredLog({
      append: async () => undefined,
      async *read() {
        yield* entries;
      },
    });
    const restored = new SessionRegistry({ resume });
    const seen: StreamEntry[] = [];

    restored.subscribeEntries((entry) => seen.push(entry));
    restored.resume(main.id);
    expect(resume.tail.every((entry) => entry.messageId === undefined)).toBe(true);
    expect(seen.at(-1)?.messageId).toBe(first);
    expect(resume.messageContexts).toEqual([{ sessionId: main.id, messageId: first }]);
  });
});

import { callIdSchema } from '@sheavly/protocol/message/message.validator';
import { MAX_NODE_CALL_ID_CHARS } from '@sheavly/protocol/node/node.constants';
import { nodeInfoSchema } from '@sheavly/protocol/node/node.validator';
import { conversationIdSchema } from '@sheavly/protocol/server/server.validator';
import { sessionIdSchema } from '@sheavly/protocol/session/session.validator';
import type { StreamEntry } from '@sheavly/protocol/stream/stream.types';
import { MemoryConversationStore } from '@sheavly/testing/store/memory-store.fake';
import { describe, expect, it } from 'vitest';
import { startHeldTask } from '../../testing/held-task.fake.js';
import { STARTED_BY } from '../../testing/sessions.fake.js';
import { TaskRegistry } from '../../tasks/tasks.service.js';
import { SessionRegistry } from '../sessions.service.js';
import { readStoredLog } from '../stored-log.helper.js';

const id = conversationIdSchema.parse('00000000-0000-4000-8000-000000000002');

/** A registry that carries on from what `store` holds, as a reopened conversation does. */
async function reopened(store: MemoryConversationStore) {
  const resume = await readStoredLog(store.entries(id));

  return new SessionRegistry({ store: store.entries(id), resume });
}

describe('a reopened conversation with sessions that were released', () => {
  it('has them back as released, not live: a long conversation does not carry every sub-agent', async () => {
    const store = new MemoryConversationStore();
    const sessions = new SessionRegistry({ store: store.entries(id) });
    const main = sessions.startMain({ title: 'Chat' });
    const kept = sessions.startChild({
      parentId: main.id,
      startedByCall: STARTED_BY,
      title: 'Kept',
    });
    const gone = sessions.startChild({
      parentId: main.id,
      startedByCall: STARTED_BY,
      title: 'Gone',
    });

    sessions.end({ id: kept.id, state: 'completed' });
    sessions.end({ id: gone.id, state: 'completed' });
    sessions.release(gone.id);
    sessions.idle({ id: main.id, outcome: 'completed' });
    await sessions.flushStore();

    const again = await reopened(store);

    expect(again.list().map((session) => session.title)).toEqual(['Chat', 'Kept']);
    expect(again.isReleased(gone.id)).toBe(true);
    expect(again.get(gone.id)).toBeUndefined();
    expect(again.releasedStarts().map((released) => released.id)).toEqual([gone.id]);
  });

  it('reopens however many sub-agents it released, since they are not live nodes', async () => {
    const store = new MemoryConversationStore();
    const sessions = new SessionRegistry({ store: store.entries(id) });
    const main = sessions.startMain({ title: 'Chat' });

    for (let spawned = 0; spawned < 1100; spawned++) {
      const child = sessions.startChild({
        parentId: main.id,
        startedByCall: STARTED_BY,
        title: `Child ${String(spawned)}`,
      });

      sessions.end({ id: child.id, state: 'completed' });
      sessions.release(child.id);
    }

    sessions.idle({ id: main.id, outcome: 'completed' });
    await sessions.flushStore();

    const again = await reopened(store);

    expect(again.list()).toHaveLength(1);
    expect(again.releasedStarts()).toHaveLength(1100);
    expect(again.nodes.list()).toHaveLength(1);
  });

  it('keeps the order sessions started in, whatever their depth', async () => {
    const store = new MemoryConversationStore();
    const sessions = new SessionRegistry({ store: store.entries(id) });
    const main = sessions.startMain({ title: 'main' });
    const first = sessions.startChild({ parentId: main.id, startedByCall: STARTED_BY, title: 'A' });

    sessions.startChild({ parentId: first.id, startedByCall: STARTED_BY, title: 'AA' });
    sessions.startChild({ parentId: main.id, startedByCall: STARTED_BY, title: 'B' });
    sessions.end({ id: first.id, state: 'completed' });
    await sessions.flushStore();

    const again = await reopened(store);

    // A parent comes before its children, and the rest keep the order they were started in.
    expect(again.list().map((session) => session.title)).toEqual(['main', 'A', 'AA', 'B']);
  });
});

/** What `store` holds of the conversation, as a list of entries. */
async function entriesOf(store: MemoryConversationStore) {
  const entries: StreamEntry[] = [];

  for await (const entry of store.entries(id).read()) entries.push(entry);

  return entries;
}

describe('a reopened conversation cut between a parent’s release and its child’s', () => {
  it('has the child back as released, not as a live session under a parent that is gone', async () => {
    const store = new MemoryConversationStore();
    const sessions = new SessionRegistry({ store: store.entries(id) });
    const main = sessions.startMain({ title: 'Chat' });
    const parent = sessions.startChild({
      parentId: main.id,
      startedByCall: STARTED_BY,
      title: 'Parent',
    });
    const child = sessions.startChild({
      parentId: parent.id,
      startedByCall: STARTED_BY,
      title: 'Child',
    });

    sessions.end({ id: child.id, state: 'completed' });
    sessions.end({ id: parent.id, state: 'completed' });
    sessions.release(parent.id);
    await sessions.flushStore();

    // A crash after the parent's release was written and before its child's: drop the last one.
    const written = await entriesOf(store);
    const last = written.findLastIndex(
      (entry) => entry.kind === 'update' && entry.update.type === 'session_released',
    );
    const cut = new MemoryConversationStore();

    for (const entry of written.slice(0, last)) await cut.entries(id).append(entry);

    const again = await reopened(cut);

    expect(again.list().map((session) => session.title)).toEqual(['Chat']);
    expect(again.isReleased(parent.id)).toBe(true);
    expect(again.isReleased(child.id)).toBe(true);
  });
});

describe('a stored session id that appears twice', () => {
  it('is refused, not restored as two nodes with the first orphaned', () => {
    const source = new SessionRegistry();
    const stored = source.startMain({ title: 'Chat' });
    const session = source.get(stored.id);

    expect(session).toBeDefined();
    expect(() => {
      new SessionRegistry({
        resume: {
          next: 0,
          tail: [],
          sessions: session ? [session, session] : [],
          lastTokens: [],
        },
      });
    }).toThrow(expect.objectContaining({ reason: 'duplicate_session' }));
  });

  it('is refused for a session started under a live id too, not left as a ghost that is never released', () => {
    const sessions = new SessionRegistry();
    const first = sessions.startMain({ title: 'a', id: sessionIdSchema.parse('m') });

    expect(() => sessions.startMain({ title: 'b', id: first.id })).toThrow(
      expect.objectContaining({ reason: 'duplicate_session' }),
    );
    expect(sessions.list().map((session) => session.title)).toEqual(['a']);
    expect(sessions.nodes.list()).toHaveLength(1);
  });
});

describe('a session started by an empty tool call id', () => {
  it('is still a sub-agent: whether it is one comes from its parent, not from the id', () => {
    const sessions = new SessionRegistry();
    const main = sessions.startMain({ title: 'main' });
    const child = sessions.startChild({
      parentId: main.id,
      startedByCall: callIdSchema.parse(''),
      title: 'sub',
    });

    expect(child).toMatchObject({ parentId: main.id, depth: 2 });
    expect(sessions.get(child.id)).toMatchObject({
      parentId: main.id,
      depth: 2,
      startedByCall: '',
    });
    expect(sessions.children(main.id).map((session) => session.id)).toEqual([child.id]);
    // It is never taken for a main session: the main one is still the first.
    expect(sessions.restoredMain()?.id).toBe(main.id);
  });
});

describe('what a session reads back', () => {
  it('is the title, status and call id it was given, while its node holds a copy fit for the wire', () => {
    const sessions = new SessionRegistry();
    const family = '👨\u200D👩\u200D👧 fix\nthe bug';
    const longCall = callIdSchema.parse('c'.repeat(300));
    const main = sessions.startMain({ title: family });
    const child = sessions.startChild({ parentId: main.id, startedByCall: longCall, title: 'sub' });

    sessions.report({ id: main.id, status: 'two\nlines' });

    // The session is what it was told: a joiner is part of an emoji, a newline is the caller's.
    expect(sessions.get(main.id)).toMatchObject({ title: family, status: 'two\nlines' });
    expect(sessions.get(child.id)).toMatchObject({ startedByCall: longCall });

    // The node is what the wire accepts.
    const nodes = sessions.nodes.list();

    expect(nodes.map((node) => node.title)).toEqual(['👨 👩 👧 fix the bug', 'sub']);
    expect(nodes[0]?.status).toBe('two lines');
    expect(nodes[1]?.spawnedBy).toHaveLength(MAX_NODE_CALL_ID_CHARS);
    expect(nodes.every((node) => nodeInfoSchema.safeParse(node).success)).toBe(true);
  });

  it('is the same after a reopen: what was given is what the stored session holds', async () => {
    const store = new MemoryConversationStore();
    const sessions = new SessionRegistry({ store: store.entries(id) });
    const main = sessions.startMain({ title: 'a\nb' });

    sessions.idle({ id: main.id, outcome: 'completed' });
    await sessions.flushStore();

    expect((await reopened(store)).get(main.id)?.title).toBe('a\nb');
  });
});

describe('a status report', () => {
  it('with nothing in it is kept and announced as it always was: the node ignores it, the session does not', () => {
    const sessions = new SessionRegistry();
    const main = sessions.startMain({ title: 'main' });
    const heard: string[] = [];

    sessions.subscribe((update) => heard.push(update.type));
    sessions.report({ id: main.id, status: 'editing' });
    sessions.report({ id: main.id, status: '' });

    expect(heard).toEqual(['session_status', 'session_status']);
    expect(sessions.get(main.id)?.status).toBe('');
    // The node has nothing it could show: its last status stands.
    expect(sessions.nodes.list()[0]?.status).toBe('editing');
  });
});

describe('releasing a sub-agent with work still running under it', () => {
  it('is refused, not thrown as a node error, until the work ends', async () => {
    const sessions = new SessionRegistry();
    const tasks = new TaskRegistry(sessions.nodeOwners);
    const main = sessions.startMain({ title: 'main' });
    const child = sessions.startChild({
      parentId: main.id,
      startedByCall: STARTED_BY,
      title: 'sub',
    });
    const command = startHeldTask({ tasks, sessionId: child.id });

    sessions.end({ id: child.id, state: 'completed' });

    // The session ended, but a command it started is still running: neither release may go ahead.
    expect(sessions.releaseAgent(child.id)).toBe(false);
    expect(() => sessions.release(child.id)).toThrow(
      expect.objectContaining({ reason: 'session_running' }),
    );
    expect(sessions.get(child.id)).toBeDefined();

    await tasks.cancel(command.id);

    expect(sessions.releaseAgent(child.id)).toBe(true);
    expect(sessions.get(child.id)).toBeUndefined();
  });
});

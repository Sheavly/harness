import { callIdSchema } from '@sheavly/protocol/message/message.validator';
import { conversationIdSchema } from '@sheavly/protocol/server/server.validator';
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

describe('a status report', () => {
  it('with nothing in it is not announced: nothing changed', () => {
    const sessions = new SessionRegistry();
    const main = sessions.startMain({ title: 'main' });
    const heard: string[] = [];

    sessions.subscribe((update) => heard.push(update.type));
    sessions.report({ id: main.id, status: 'editing' });
    sessions.report({ id: main.id, status: ' \n ' });

    expect(heard).toEqual(['session_status']);
    expect(sessions.get(main.id)?.status).toBe('editing');
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

import { describe, expect, it } from 'vitest';
import { SessionRegistry } from '../sessions.service.js';
import { TaskRegistry } from '../../tasks/tasks.service.js';
import { STARTED_BY, startDeepestSession } from '../../testing/sessions.fake.js';
import type { SessionId } from '@sheavly/protocol/session/session.types';
import { sessionIdSchema } from '@sheavly/protocol/session/session.validator';
import { approvalIdSchema } from '@sheavly/protocol/approval/approval.validator';
import { callIdSchema, messageIdSchema } from '@sheavly/protocol/message/message.validator';
import type { StreamEntry } from '@sheavly/protocol/stream/stream.types';

const MESSAGE_ID = messageIdSchema.parse('0f8fad5b-d9cb-469f-a165-70867728950e');

/** One line per entry: `seq session kind:type`. */
const describeEntry = (entry: StreamEntry, names: Record<string, string>) =>
  `${String(entry.seq)} ${names[entry.sessionId] ?? '?'} ${
    entry.kind === 'event' ? `event:${entry.event.type}` : `update:${entry.update.type}`
  }`;

/** Starts a main session with one sub-agent under it, before anyone listens. */
function startMainWithChild(sessions: SessionRegistry) {
  const main = sessions.startMain({ title: 'Main' });
  const child = sessions.startChild({
    parentId: main.id,
    startedByCall: STARTED_BY,
    title: 'Child',
  });

  return { main, child };
}

describe("SessionRegistry's combined stream", () => {
  it('orders every session’s updates and published events in one seq with no gaps', () => {
    const sessions = new SessionRegistry();
    const entries: StreamEntry[] = [];

    sessions.subscribeEntries((entry) => entries.push(entry));

    const main = sessions.startMain({ title: 'Main' });
    const child = sessions.startChild({
      parentId: main.id,
      startedByCall: STARTED_BY,
      title: 'Child',
    });

    sessions.publish({ sessionId: main.id, event: { seq: 0, type: 'text_delta', text: 'a' } });
    sessions.publish({ sessionId: child.id, event: { seq: 0, type: 'text_delta', text: 'b' } });
    sessions.report({ id: child.id, status: 'working' });
    sessions.end({ id: child.id, state: 'completed' });

    const names = { [main.id]: 'main', [child.id]: 'child' };

    expect(entries.map((entry) => describeEntry(entry, names))).toEqual([
      '0 main update:session_started',
      '1 child update:session_started',
      '2 main event:text_delta',
      '3 child event:text_delta',
      '4 child update:session_status',
      '5 child update:session_ended',
    ]);
  });

  it('keeps each event as the loop numbered it, and refuses one for an unknown session', () => {
    const sessions = new SessionRegistry();
    const main = sessions.startMain({ title: 'Main' });
    const entries: StreamEntry[] = [];

    sessions.subscribeEntries((entry) => entries.push(entry));
    sessions.publish({ sessionId: main.id, event: { seq: 7, type: 'text_delta', text: 'a' } });

    expect(entries).toEqual([
      {
        seq: 1, // the main session's start was entry 0
        at: expect.any(Number) as number,
        sessionId: main.id,
        kind: 'event',
        event: { seq: 7, type: 'text_delta', text: 'a' },
      },
    ]);
    expect(() =>
      sessions.publish({
        sessionId: sessionIdSchema.parse('nope'),
        event: { seq: 0, type: 'text_delta', text: 'a' },
      }),
    ).toThrow('Unknown session nope');
  });

  it('keeps a done without its history, for live listeners and replay alike', () => {
    const sessions = new SessionRegistry();
    const main = sessions.startMain({ title: 'Main' });
    const live: StreamEntry[] = [];
    const history = [{ role: 'user' as const, content: 'a long conversation' }];

    sessions.subscribeEntries((entry) => live.push(entry));
    sessions.publish({
      sessionId: main.id,
      event: { seq: 0, type: 'done', reason: 'completed', messages: history, session: main },
    });

    const replayed: StreamEntry[] = [];

    sessions.subscribeEntries((entry) => replayed.push(entry), { replay: true });

    for (const entries of [live, replayed]) {
      expect(entries.at(-1)).toEqual({
        seq: 1,
        at: expect.any(Number) as number,
        sessionId: main.id,
        kind: 'event',
        event: { seq: 0, type: 'done', reason: 'completed', session: main },
      });
    }
  });

  it('files each approval and its answer under the session whose tool asked', () => {
    const sessions = new SessionRegistry();
    const { main, child } = startMainWithChild(sessions);
    const entries: StreamEntry[] = [];
    const request = (id: string, sessionId?: SessionId) => ({
      type: 'approval_requested' as const,
      request: {
        id: approvalIdSchema.parse(id),
        callId: callIdSchema.parse('c'),
        ...(sessionId && { sessionId }),
        tool: 'run_command',
        command: 'rm -rf build',
        concerns: [],
        options: ['approve', 'skip', 'skip_with_message'] as const,
      },
    });

    sessions.subscribeEntries((entry) => entries.push(entry), { sessionId: child.id });
    sessions.publishApproval(request('a1', child.id));
    sessions.publishApproval({
      type: 'approval_resolved',
      id: approvalIdSchema.parse('a1'),
      response: { decision: 'approve' },
    });
    // A call outside the loop names no session: it goes under the main one, not the child.
    sessions.publishApproval(request('a2'));

    // The child's filter sees its own approval and the answer, filed under the same session.
    expect(
      entries.map((entry) => `${entry.kind}:${entry.kind === 'approval' ? entry.update.type : ''}`),
    ).toEqual(['approval:approval_requested', 'approval:approval_resolved']);

    const all: StreamEntry[] = [];

    sessions.subscribeEntries((entry) => all.push(entry), { replay: true });
    expect(all.at(-1)).toMatchObject({ kind: 'approval', sessionId: main.id });
  });

  it('files each task under the session that started it, or main when none did', () => {
    const sessions = new SessionRegistry();
    const { main, child } = startMainWithChild(sessions);
    const tasks = new TaskRegistry();
    const entries: StreamEntry[] = [];

    tasks.observe((task) => sessions.publishTask(task));
    sessions.subscribeEntries((entry) => entries.push(entry));
    tasks.start({
      command: 'npm run dev',
      description: 'Dev server',
      sessionId: child.id,
      run: () => new Promise(() => undefined),
    });
    tasks.start({
      command: 'npm test',
      description: 'Tests',
      run: () => new Promise(() => undefined),
    });

    expect(entries.map(({ kind, sessionId }) => ({ kind, sessionId }))).toEqual([
      { kind: 'task', sessionId: child.id },
      { kind: 'task', sessionId: main.id },
    ]);
  });

  it('puts a queue change in order with the runs, under the main session, and refuses an unknown one', () => {
    const sessions = new SessionRegistry();
    const seen: StreamEntry[] = [];

    sessions.subscribeEntries((entry) => seen.push(entry));

    const { id } = sessions.startMain({ title: 'Main' });

    sessions.publishQueue({
      sessionId: id,
      update: { type: 'prompt_started', messageId: MESSAGE_ID, text: 'next', queued: [] },
    });
    sessions.idle({ id, outcome: 'completed' });

    expect(seen.map((entry) => `${String(entry.seq)} ${entry.kind}`)).toEqual([
      '0 update',
      '1 queue',
      '2 update',
    ]);
    expect(seen.every((entry) => entry.sessionId === id)).toBe(true);
    expect(() =>
      sessions.publishQueue({
        sessionId: sessionIdSchema.parse('nobody'),
        update: { type: 'queue_changed', queued: [] },
      }),
    ).toThrow();
  });

  it('stops telling a listener once it unsubscribes', () => {
    const sessions = new SessionRegistry();
    const entries: StreamEntry[] = [];
    const stop = sessions.subscribeEntries((entry) => entries.push(entry));

    sessions.startMain({ title: 'Main' });
    stop();
    sessions.startMain({ title: 'Second' });

    expect(entries).toHaveLength(1);
  });

  it('follows one session alone, or with its sub-agents, and replays what it missed', () => {
    const sessions = new SessionRegistry();
    const grandchild = startDeepestSession(sessions);
    const [main, child] = sessions.list();

    if (!main || !child) throw new Error('startDeepestSession starts three sessions');
    const names = { [main.id]: 'main', [child.id]: 'child', [grandchild.id]: 'grandchild' };
    const say = (id: SessionId, seq: number) =>
      sessions.publish({ sessionId: id, event: { seq, type: 'text_delta', text: 'x' } });

    say(child.id, 0); // before anyone listens
    const only: string[] = [];
    const tree: string[] = [];

    sessions.subscribeEntries((e) => only.push(describeEntry(e, names)), {
      sessionId: child.id,
      replay: true,
    });
    sessions.subscribeEntries((e) => tree.push(describeEntry(e, names)), {
      sessionId: child.id,
      subtree: true,
    });
    say(main.id, 0);
    say(grandchild.id, 0);
    say(child.id, 1);

    expect(only).toEqual([
      '1 child update:session_started',
      '3 child event:text_delta',
      '6 child event:text_delta',
    ]);
    expect(tree).toEqual(['5 grandchild event:text_delta', '6 child event:text_delta']);
  });

  it('gives listeners frozen copies, so none can change what the run holds', () => {
    const sessions = new SessionRegistry();
    const main = sessions.startMain({ title: 'Main' });
    const event = { seq: 0, type: 'text_delta' as const, text: 'mine' };
    let received: StreamEntry | undefined;

    sessions.subscribeEntries((entry) => (received = entry));
    sessions.publish({ sessionId: main.id, event });

    expect(received?.kind === 'event' && received.event).not.toBe(event);
    expect(Object.isFrozen(received)).toBe(true);
    expect(() => {
      if (received?.kind === 'event') Object.assign(received.event, { text: 'changed' });
    }).toThrow();
    expect(event.text).toBe('mine');
  });

  it('keeps a throwing listener from the run and the other listeners, and still reports it', async () => {
    const sessions = new SessionRegistry();
    const main = sessions.startMain({ title: 'Main' });
    const seen: number[] = [];
    const uncaught: unknown[] = [];
    const onUncaught = (error: unknown) => uncaught.push(error);

    process.on('uncaughtException', onUncaught);
    sessions.subscribeEntries(() => {
      throw new Error('broken view');
    });
    sessions.subscribeEntries((entry) => seen.push(entry.seq));

    expect(() =>
      sessions.publish({ sessionId: main.id, event: { seq: 0, type: 'text_delta', text: 'a' } }),
    ).not.toThrow();
    expect(seen).toEqual([1]);
    await new Promise((resolve) => setTimeout(resolve, 0));
    process.off('uncaughtException', onUncaught);
    expect(uncaught).toEqual([new Error('broken view')]);
  });
});

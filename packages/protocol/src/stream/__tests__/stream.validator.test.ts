import { describe, expect, it } from 'vitest';
import { streamEntrySchema } from '../stream.validator.js';

const MESSAGE_ID = '0f8fad5b-d9cb-469f-a165-70867728950e';
const SESSION = {
  id: 'child',
  parentId: 'main',
  startedByCall: 'start-call',
  rootId: 'main',
  depth: 2,
  title: 'Read the docs',
  state: 'running',
  startedAt: 1,
};

describe('streamEntrySchema', () => {
  it("accepts a session's event and a session update, each naming its session", () => {
    const entries = [
      {
        seq: 0,
        at: 1_700_000_000_000,
        sessionId: 'child',
        kind: 'update',
        update: { type: 'session_started', session: SESSION },
      },
      {
        seq: 1,
        at: 1_700_000_000_001,
        sessionId: 'child',
        kind: 'event',
        event: { seq: 0, type: 'text_delta', text: 'hi' },
      },
    ];

    for (const entry of entries) expect(streamEntrySchema.parse(entry)).toEqual(entry);
  });

  it('takes an extension event published with seq 0 at a later stream position', () => {
    // Published outside any run, like storage_failed: the event's own seq is 0, the entry's is not.
    const entry = {
      seq: 12,
      at: 5,
      sessionId: 'main',
      kind: 'event',
      event: {
        seq: 0,
        type: 'extension_event',
        extension: 'acme',
        kind: 'acme.thing',
        version: 1,
        data: { n: 1 },
        text: 'A thing happened',
      },
    };

    expect(streamEntrySchema.parse(entry)).toEqual(entry);
  });

  it('rejects an entry without its session, a negative seq or an unknown kind', () => {
    const event = { seq: 0, type: 'text_delta', text: 'hi' };
    const base = { seq: 0, at: 1, sessionId: 'main', kind: 'event', event };

    expect(streamEntrySchema.safeParse({ ...base, sessionId: undefined }).success).toBe(false);
    expect(streamEntrySchema.safeParse({ ...base, seq: -1 }).success).toBe(false);
    expect(streamEntrySchema.safeParse({ ...base, kind: 'log' }).success).toBe(false);
  });

  it('rejects an entry with no time, or one that is not whole non-negative milliseconds', () => {
    const base = {
      seq: 0,
      sessionId: 'main',
      kind: 'event',
      event: { seq: 0, type: 'text_delta', text: 'hi' },
    };

    expect(streamEntrySchema.safeParse(base).success).toBe(false);

    for (const at of [-1, 1.5, '2026-11-04T12:00:00Z', null]) {
      expect(streamEntrySchema.safeParse({ ...base, at }).success).toBe(false);
    }

    expect(streamEntrySchema.safeParse({ ...base, at: 0 }).success).toBe(true);
  });

  it('takes a done without messages, so the stream never carries the history', () => {
    const session = { id: 'main', rootId: 'main', depth: 1 };
    const done = { seq: 3, type: 'done', reason: 'completed', session };
    const entry = { seq: 9, at: 5, sessionId: 'main', kind: 'event' };

    expect(streamEntrySchema.parse({ ...entry, event: done })).toEqual({ ...entry, event: done });
    // A run's own done (with messages) parses too, but the stream drops what the schema doesn't know.
    const parsed = streamEntrySchema.parse({
      ...entry,
      event: { ...done, messages: [{ role: 'user', content: 'hi' }] },
    });

    expect(parsed.kind === 'event' && 'messages' in parsed.event).toBe(false);
  });

  it("takes an approval a session's tool asked for, and its answer", () => {
    const requested = {
      seq: 4,
      at: 6,
      sessionId: 'main',
      kind: 'approval',
      update: {
        type: 'approval_requested',
        request: {
          id: 'a1',
          callId: 'c1',
          sessionId: 'main',
          tool: 'run_command',
          command: 'rm -rf build',
          concerns: [],
          options: ['approve', 'skip', 'skip_with_message'],
        },
      },
    };
    const resolved = {
      seq: 5,
      at: 7,
      sessionId: 'main',
      kind: 'approval',
      update: { type: 'approval_resolved', id: 'a1', response: { decision: 'skip' } },
    };

    for (const entry of [requested, resolved]) {
      expect(streamEntrySchema.parse(entry)).toEqual(entry);
    }
  });

  it('carries a background task starting and ending, under the session that started it', () => {
    const task = {
      id: 't1',
      kind: 'service',
      command: 'npm run dev',
      description: 'Dev server',
      startedAt: 1,
    };
    const started = {
      seq: 6,
      at: 8,
      sessionId: 'main',
      kind: 'task',
      update: { type: 'task_started', task: { ...task, status: 'running', output: '' } },
    };
    const ended = {
      seq: 7,
      at: 9,
      sessionId: 'main',
      kind: 'task',
      update: {
        type: 'task_ended',
        task: { ...task, status: 'failed', endedAt: 2, exitCode: 1, output: 'boom' },
      },
    };

    for (const entry of [started, ended]) {
      expect(streamEntrySchema.parse(entry)).toEqual(entry);
    }

    expect(
      streamEntrySchema.safeParse({ ...started, update: { type: 'task_paused', task } }).success,
    ).toBe(false);
  });

  it('carries the queue after each change: a line joining, starting, or refused', () => {
    const entry = { seq: 8, at: 10, sessionId: 'main', kind: 'queue' };
    const updates = [
      { type: 'queue_changed', queued: ['first', 'second'] },
      { type: 'queue_changed', queued: ['first'], dropped: [MESSAGE_ID] },
      { type: 'prompt_started', messageId: MESSAGE_ID, text: 'first', queued: ['second'] },
      {
        type: 'prompt_refused',
        messageId: MESSAGE_ID,
        text: 'second',
        error: 'No skill is called nope',
        queued: [],
      },
    ];

    for (const update of updates) {
      expect(streamEntrySchema.parse({ ...entry, update })).toEqual({ ...entry, update });
    }
  });

  it('rejects a started or refused line with no message id, and a dropped that is not ids', () => {
    const entry = { seq: 8, at: 10, sessionId: 'main', kind: 'queue' };
    const updates = [
      { type: 'prompt_started', text: 'first', queued: [] },
      { type: 'prompt_refused', text: 'second', error: 'no', queued: [] },
      { type: 'prompt_started', messageId: 'm1', text: 'first', queued: [] },
      { type: 'queue_changed', queued: [], dropped: ['first'] },
      { type: 'queue_changed', queued: [], dropped: MESSAGE_ID },
    ];

    for (const update of updates) {
      expect(streamEntrySchema.safeParse({ ...entry, update }).success).toBe(false);
    }
  });

  it('rejects a queue update without the queue it leaves, or with an empty line', () => {
    const entry = { seq: 8, at: 10, sessionId: 'main', kind: 'queue' };

    expect(
      streamEntrySchema.safeParse({
        ...entry,
        update: { type: 'prompt_started', messageId: MESSAGE_ID, text: 'hi' },
      }).success,
    ).toBe(false);
    expect(
      streamEntrySchema.safeParse({ ...entry, update: { type: 'queue_changed', queued: [''] } })
        .success,
    ).toBe(false);
    // A prompt of skills alone writes as nothing, and every follower must still read its start.
    expect(
      streamEntrySchema.safeParse({
        ...entry,
        update: { type: 'prompt_started', messageId: MESSAGE_ID, text: '', queued: [] },
      }).success,
    ).toBe(true);
  });
});

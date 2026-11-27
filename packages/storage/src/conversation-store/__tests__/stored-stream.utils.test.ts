import { describe, expect, it } from 'vitest';
import { parseStoredStreamEntry } from '../stored-stream.utils.js';

const SESSION = '7c3e1a90-2b4d-4e6f-8a1c-3d5e7f9b0a12';
const MODEL = '4b1f9a52-3c5e-4a77-9d64-0e2b7f1c8a30';
const MESSAGE = '5a1f3c82-9d4e-4b17-8c60-2e7a9b1d4f33';
const PLACEHOLDER = '00000000-0000-4000-8000-000000000000';

/** The main session as an entry says it, with `extra` on it (an old version's key). */
const idleOf = (extra: Record<string, unknown>) => ({
  seq: 3,
  at: 9,
  sessionId: SESSION,
  kind: 'update',
  update: {
    type: 'session_idle',
    session: {
      id: SESSION,
      rootId: SESSION,
      depth: 1,
      title: 'Chat',
      state: 'idle',
      lastOutcome: 'completed',
      startedAt: 1,
      modelId: MODEL,
      ...extra,
    },
  },
});

const queueEntry = (update: Record<string, unknown>) => ({
  seq: 4,
  at: 9,
  sessionId: SESSION,
  kind: 'queue',
  update,
});

describe('the stream entry a stored line holds', () => {
  it('is the entry, for a line in today’s form', () => {
    const line = idleOf({ effort: 'low' });

    expect(parseStoredStreamEntry(line)).toEqual(line);
  });

  it('reads a session snapshot written with "mode" as its effort', () => {
    expect(parseStoredStreamEntry(idleOf({ mode: 'high' }))).toEqual(idleOf({ effort: 'high' }));
  });

  it('reads a queue line written before a queued line had a message id, and keeps one that has', () => {
    const started = { type: 'prompt_started', text: 'go', queued: [] };

    expect(parseStoredStreamEntry(queueEntry(started))).toEqual(
      queueEntry({ messageId: PLACEHOLDER, ...started }),
    );

    const withId = queueEntry({ ...started, messageId: MESSAGE });

    expect(parseStoredStreamEntry(withId)).toEqual(withId);
  });

  it('is undefined for what is not an entry, and for an old key that is still not valid', () => {
    expect(parseStoredStreamEntry({ kind: 'update', seq: 1 })).toBeUndefined();
    expect(parseStoredStreamEntry('not an entry')).toBeUndefined();
    expect(parseStoredStreamEntry(idleOf({ mode: 'turbo' }))).toBeUndefined();
  });
});

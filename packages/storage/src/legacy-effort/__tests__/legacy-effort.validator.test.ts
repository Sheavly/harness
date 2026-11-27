import { describe, expect, it } from 'vitest';
import { LEGACY_QUEUE_MESSAGE_ID } from '../legacy-effort.constants.js';
import { readLegacyStreamEntry } from '../legacy-effort.utils.js';
import {
  storedConversationIndexSchema,
  storedProfileFileSchema,
  storedStreamEntrySchema,
} from '../legacy-effort.validator.js';

const MODEL = '4b1f9a52-3c5e-4a77-9d64-0e2b7f1c8a30';
const PROFILE = '9d2c7e10-6a4b-4f38-b1e5-5c0a8d3f2b71';
const INDEX = {
  id: '00000000-0000-4000-8000-000000000001',
  title: 'Chat',
  modelId: MODEL,
  workspace: '/work/repo',
  profile: PROFILE,
  status: 'closed',
  startedAt: 1,
  updatedAt: 2,
};

describe('a conversation index written before "mode" became "effort"', () => {
  it('reads its mode as the effort', () => {
    expect(storedConversationIndexSchema.parse({ ...INDEX, mode: 'high' })).toEqual({
      ...INDEX,
      effort: 'high',
    });
  });

  it('reads one in the current form as it is, and prefers the effort when both are there', () => {
    expect(storedConversationIndexSchema.parse({ ...INDEX, effort: 'low' })).toEqual({
      ...INDEX,
      effort: 'low',
    });
    expect(storedConversationIndexSchema.parse({ ...INDEX, mode: 'high', effort: 'low' })).toEqual({
      ...INDEX,
      effort: 'low',
    });
  });

  it('still refuses an index with no effort, and one with a value that is not an effort', () => {
    expect(storedConversationIndexSchema.safeParse(INDEX).success).toBe(false);
    expect(storedConversationIndexSchema.safeParse({ ...INDEX, mode: 'turbo' }).success).toBe(
      false,
    );
  });

  it('does not let a file with a __proto__ key change what every object inherits', () => {
    const hostile: unknown = JSON.parse(
      JSON.stringify({ ...INDEX, mode: 'low' }).replace('{', '{"__proto__":{"polluted":true},'),
    );
    const parsed = storedConversationIndexSchema.parse(hostile);

    expect(parsed).toEqual({ ...INDEX, effort: 'low' });
    expect(Object.getPrototypeOf(parsed)).toBe(Object.prototype);
    const fresh: { polluted?: boolean } = {};

    expect(fresh.polluted).toBeUndefined();
  });
});

describe('a profile written before "mode" became "effort"', () => {
  const profile = { id: PROFILE, name: 'Work' };

  it('reads the remembered selection and per-model modes as efforts', () => {
    expect(
      storedProfileFileSchema.parse({
        ...profile,
        lastModelSelection: { modelId: MODEL, mode: 'extreme' },
        modelModes: { [MODEL]: 'extreme' },
      }),
    ).toEqual({
      ...profile,
      lastModelSelection: { modelId: MODEL, effort: 'extreme' },
      modelEfforts: { [MODEL]: 'extreme' },
    });
  });

  it('reads a profile with no remembered model as it is, and one in the current form unchanged', () => {
    const current = {
      ...profile,
      lastModelSelection: { modelId: MODEL, effort: 'low' },
      modelEfforts: { [MODEL]: 'low' },
    };

    expect(storedProfileFileSchema.parse(profile)).toEqual(profile);
    expect(storedProfileFileSchema.parse(current)).toEqual(current);
  });

  it('prefers the new key when both are there, and still refuses a value that is not an effort', () => {
    expect(
      storedProfileFileSchema.parse({
        ...profile,
        modelModes: { [MODEL]: 'low' },
        modelEfforts: { [MODEL]: 'high' },
      }),
    ).toEqual({ ...profile, modelEfforts: { [MODEL]: 'high' } });
    expect(
      storedProfileFileSchema.safeParse({ ...profile, modelModes: { [MODEL]: 'turbo' } }).success,
    ).toBe(false);
  });
});

describe('a stream entry written before "mode" became "effort"', () => {
  const SESSION = '7c3e1a90-2b4d-4e6f-8a1c-3d5e7f9b0a12';
  const snapshot = {
    id: SESSION,
    rootId: SESSION,
    depth: 1,
    title: 'Conversation',
    state: 'running',
    startedAt: 1,
    modelId: MODEL,
  };
  const entry = (update: Record<string, unknown>) => ({
    seq: 1,
    sessionId: SESSION,
    kind: 'update',
    update,
    at: 2,
  });

  it('reads the mode of a model switch and of its session snapshot as the effort', () => {
    expect(
      storedStreamEntrySchema.parse(
        entry({
          type: 'session_model',
          session: { ...snapshot, mode: 'medium' },
          modelId: MODEL,
          mode: 'medium',
        }),
      ),
    ).toEqual(
      entry({
        type: 'session_model',
        session: { ...snapshot, effort: 'medium' },
        modelId: MODEL,
        effort: 'medium',
      }),
    );
  });

  it('reads the mode of any update on a session, whose main-session snapshot refuses the key', () => {
    expect(
      storedStreamEntrySchema.parse(
        entry({ type: 'session_idle', session: { ...snapshot, mode: 'high' } }),
      ),
    ).toEqual(entry({ type: 'session_idle', session: { ...snapshot, effort: 'high' } }));
  });

  it('reads one in the current form as it is, and prefers the effort when both are there', () => {
    const current = entry({
      type: 'session_model',
      session: { ...snapshot, effort: 'low' },
      modelId: MODEL,
      effort: 'low',
    });

    expect(storedStreamEntrySchema.parse(current)).toEqual(current);
    expect(
      storedStreamEntrySchema.parse(
        entry({
          type: 'session_model',
          session: { ...snapshot, mode: 'high', effort: 'low' },
          modelId: MODEL,
          mode: 'high',
          effort: 'low',
        }),
      ),
    ).toEqual(current);
  });

  it('still refuses an old mode that is not an effort', () => {
    expect(
      storedStreamEntrySchema.safeParse(
        entry({ type: 'session_model', session: snapshot, modelId: MODEL, mode: 'turbo' }),
      ).success,
    ).toBe(false);
  });

  it('leaves a mode outside a session update alone, where it means something else', () => {
    const approval = { ...entry({ mode: 'ask' }), kind: 'approval' };

    expect(readLegacyStreamEntry(approval)).toBe(approval);
  });
});

describe('a queue entry written before a queued line had a message id', () => {
  const SESSION = '7c3e1a90-2b4d-4e6f-8a1c-3d5e7f9b0a12';
  const MESSAGE = '5a1f3c82-9d4e-4b17-8c60-2e7a9b1d4f33';
  const entry = (update: Record<string, unknown>) => ({
    seq: 7,
    sessionId: SESSION,
    kind: 'queue',
    update,
    at: 2,
  });

  it.each([
    ['a line that started', { type: 'prompt_started', text: 'go', queued: ['next'] }],
    [
      'a line that was refused',
      { type: 'prompt_refused', text: 'go', error: 'It cannot run', queued: [] },
    ],
  ])('is read with the placeholder id for %s, so a stored conversation still replays', (_, old) => {
    expect(storedStreamEntrySchema.parse(entry(old))).toEqual(
      entry({ messageId: LEGACY_QUEUE_MESSAGE_ID, ...old }),
    );
  });

  it('reads one that has an id as it is, and an update that never had one as it is', () => {
    const current = entry({ type: 'prompt_started', messageId: MESSAGE, text: 'go', queued: [] });
    const changed = entry({ type: 'queue_changed', queued: ['a'] });

    expect(storedStreamEntrySchema.parse(current)).toEqual(current);
    expect(storedStreamEntrySchema.parse(changed)).toEqual(changed);
  });

  it('still refuses an id that is not one, instead of replacing it with the placeholder', () => {
    expect(
      storedStreamEntrySchema.safeParse(
        entry({ type: 'prompt_started', messageId: 'm1', text: 'go', queued: [] }),
      ).success,
    ).toBe(false);
  });
});

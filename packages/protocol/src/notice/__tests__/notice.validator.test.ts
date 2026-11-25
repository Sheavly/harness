import { describe, expect, it } from 'vitest';
import { harnessNoticeSchema, persistentNoticeSchema } from '../notice.validator.js';
import { MAX_HOOK_FAILED_ERROR_CHARS, NOTICE_LIFETIMES } from '../notice.constants.js';
import {
  MAX_EXTENSION_DATA_BYTES,
  MAX_EXTENSION_TEXT_CHARS,
} from '../../extension/extension.constants.js';
import {
  clientHistoryMessageSchema,
  historyMessageSchema,
} from '../../history/history.validator.js';
import { agentEventSchema, entryEventSchema } from '../../event/event.validator.js';
import { contractJsonSchema } from '../../contract/contract.utils.js';

describe('harness notices on the wire', () => {
  it('no longer reads the removed output_continuation event, so a stored stream holding it fails', () => {
    const event = { type: 'output_continuation', seq: 0, attempt: 1, maxAttempts: 2 };

    expect(entryEventSchema.safeParse(event).success).toBe(false);
  });

  it.each([
    { kind: 'output-continuation', attempt: 1 },
    { kind: 'output-continuation', attempt: 2, maxAttempts: 5 },
    { kind: 'output-continuation', attempt: 1, reason: 'connection' },
    { kind: 'output-continuation', attempt: 1, reason: 'output_limit' },
  ])('preserves structured recovery data in %j for every UI', (notice) => {
    const event = { type: 'harness_notice', seq: 0, notice };

    expect(harnessNoticeSchema.parse(notice)).toEqual(notice);
    expect(entryEventSchema.parse(JSON.parse(JSON.stringify(event)))).toEqual(event);
  });

  it.each([
    { attempt: 0 },
    { attempt: -1 },
    { attempt: 1.5 },
    { attempt: 1, maxAttempts: 0 },
    { attempt: 1, maxAttempts: Infinity },
    { attempt: 1, reason: 'weather' },
  ])('rejects invalid recovery data in %j', (data) => {
    expect(harnessNoticeSchema.safeParse({ kind: 'output-continuation', ...data }).success).toBe(
      false,
    );
  });

  it.each([
    { window: 1_000_000 },
    { used: 0 },
    { window: 1_000_000, used: 668_100 },
    { window: 1_000, used: 1_250 },
  ])('preserves the known counts in %j without adding presentation', (context) => {
    const notice = { kind: 'context-usage', context };
    const event = { type: 'harness_notice', seq: 0, notice };

    expect(harnessNoticeSchema.parse(notice)).toEqual(notice);
    expect(agentEventSchema.parse(event)).toEqual(event);
    expect(entryEventSchema.parse(JSON.parse(JSON.stringify(event)))).toEqual(event);
  });

  it.each([
    {},
    { window: 0 },
    { window: -1, used: 100 },
    { window: 1.5, used: 100 },
    { window: 10_000_001 },
    { used: -1 },
    { used: 1.5 },
    { used: null },
    { window: '1000', used: 10 },
  ])('rejects unknown or invalid measurements in %j', (context) => {
    expect(harnessNoticeSchema.safeParse({ kind: 'context-usage', context }).success).toBe(false);
  });

  it.each([
    { kind: 'hook-failed', hook: 'audit', handler: 'beforeTurn', error: 'boom' },
    { kind: 'hook-failed', hook: 'audit', handler: 'afterTurn', error: 'boom', repeats: 3 },
  ])('keeps the failed hook in %j on the stream and in history', (notice) => {
    const event = { type: 'harness_notice', seq: 0, notice };

    expect(harnessNoticeSchema.parse(notice)).toEqual(notice);
    expect(persistentNoticeSchema.parse(notice)).toEqual(notice);
    expect(entryEventSchema.parse(JSON.parse(JSON.stringify(event)))).toEqual(event);
    expect(historyMessageSchema.parse({ role: 'notice', notice, at: 1 })).toEqual({
      role: 'notice',
      notice,
      at: 1,
    });
  });

  it.each([
    { hook: '', handler: 'beforeTurn', error: 'x' },
    { hook: 'audit', handler: '', error: 'x' },
    { hook: 'audit', handler: 'beforeTurn', error: 'x'.repeat(MAX_HOOK_FAILED_ERROR_CHARS + 1) },
    { hook: 'audit', handler: 'beforeTurn', error: 'x', repeats: 0 },
  ])('rejects an invalid hook failure in %j', (data) => {
    expect(harnessNoticeSchema.safeParse({ kind: 'hook-failed', ...data }).success).toBe(false);
  });

  describe('extension-notice', () => {
    const notice = {
      kind: 'extension-notice',
      extension: 'acme',
      topic: 'acme.build-status',
      version: 1,
      data: { failing: ['a', 'b'], count: 2 },
      text: 'Two builds are failing',
    };

    it('round trips on the stream, in history, and as a persistent notice', () => {
      const onStream = entryEventSchema.parse(
        JSON.parse(JSON.stringify({ type: 'harness_notice', seq: 0, notice })),
      );
      const stored = historyMessageSchema.parse(
        JSON.parse(JSON.stringify({ role: 'notice', notice, at: 1 })),
      );

      expect([harnessNoticeSchema, persistentNoticeSchema].map((s) => s.parse(notice))).toEqual([
        notice,
        notice,
      ]);
      expect(onStream).toMatchObject({ notice });
      expect(stored).toMatchObject({ notice });
    });

    it('is persistent, so a stored history entry parses and a client cannot send one', () => {
      expect(NOTICE_LIFETIMES['extension-notice']).toBe('persistent');
      expect(clientHistoryMessageSchema.safeParse({ role: 'notice', notice, at: 1 }).success).toBe(
        false,
      );
    });

    it('parses any topic in the extension namespace, known or not', () => {
      const unknown = { ...notice, extension: 'other', topic: 'other.something-new' };

      expect(persistentNoticeSchema.parse(unknown)).toEqual(unknown);
    });

    it.each(['other.build-status', 'acmeco.build-status', 'build-status', 'acme.'])(
      'rejects the topic %j outside the extension namespace',
      (topic) => {
        expect(harnessNoticeSchema.safeParse({ ...notice, topic }).success).toBe(false);
      },
    );

    it.each([0, -2, 1.5, '1'])('rejects the version %j', (version) => {
      expect(harnessNoticeSchema.safeParse({ ...notice, version }).success).toBe(false);
    });

    it('rejects a name that is not kebab-case', () => {
      const bad = { ...notice, extension: 'Acme', topic: 'Acme.x' };

      expect(harnessNoticeSchema.safeParse(bad).success).toBe(false);
    });

    it('rejects empty text, text over the cap and data over the byte cap', () => {
      const tooLong = 'x'.repeat(MAX_EXTENSION_TEXT_CHARS + 1);
      const tooBig = 'x'.repeat(MAX_EXTENSION_DATA_BYTES);

      expect(harnessNoticeSchema.safeParse({ ...notice, text: '' }).success).toBe(false);
      expect(harnessNoticeSchema.safeParse({ ...notice, text: tooLong }).success).toBe(false);
      expect(harnessNoticeSchema.safeParse({ ...notice, data: tooBig }).success).toBe(false);
    });
  });

  it('rejects arbitrary prose and notice kinds outside the shared contract', () => {
    expect(harnessNoticeSchema.safeParse('Context: 67%').success).toBe(false);
    expect(harnessNoticeSchema.safeParse({ kind: 'toast', context: { used: 100 } }).success).toBe(
      false,
    );
  });

  it('exports the notice schema for clients that do not use TypeScript', () => {
    expect(contractJsonSchema().$defs).toHaveProperty('HarnessNotice');
  });
});

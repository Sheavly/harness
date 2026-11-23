import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { readHistoryEntries } from '@sheavly/core/store/history-log.helper';
import { FileConversationStore } from '@sheavly/storage/conversation-store/conversation-store.service';
import { diagnosticRecordSchema } from '@sheavly/storage/conversation-store/diagnostic-record.validator';
import { conversationIdSchema } from '@sheavly/protocol/server/server.validator';
import { testApi, reply } from '../../testing/api.fake.js';
import { DEEP_ID } from '@sheavly/host/testing/run.fake';

describe('correlated chat diagnostics through the API', () => {
  it('persists each user message ID and links the failed run to the correct message after earlier success', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'diagnostic-api-'));
    const written = vi.spyOn(process.stderr, 'write').mockReturnValue(true);
    const store = new FileConversationStore({ folder: root, onProblem: () => undefined });
    const api = testApi(
      {
        first: [
          reply('OK'),
          () => {
            throw new Error('Model failed apiKey=private-key', {
              cause: Object.assign(new Error('Socket closed'), { code: 'ECONNRESET' }),
            });
          },
        ],
      },
      store,
    );

    try {
      const id = conversationIdSchema.parse(await api.start());

      for (const text of ['first', 'fail']) {
        if (text === 'fail') await api.conversations.useModel({ id, modelId: DEEP_ID });
        const entries = [];

        for await (const { entry } of api.runOf({ id, text })) entries.push(entry);

        if (text === 'fail') expect(JSON.stringify(entries)).toContain('"type":"run_failed"');
      }

      await api.conversations.close(id);
      const history = await readHistoryEntries(store.history({ id }));
      const users = history.filter((message) => message.role === 'user');
      const log = await readFile(path.join(root, 'conversations', id, 'errors.jsonl'), 'utf8');
      const record = diagnosticRecordSchema.parse(JSON.parse(log.trim()));

      expect(users).toHaveLength(2);
      expect(users[0]?.id).toBeDefined();
      expect(users[1]?.id).not.toBe(users[0]?.id);
      expect(record.messageId).toBe(users[1]?.id);
      expect(record.conversationId).toBe(id);
      expect(record.modelId).toBe(DEEP_ID);
      expect(record.error).toBe('Model failed apiKey=[REDACTED]');
      expect(record.details?.causes[0]?.code).toBe('ECONNRESET');
      expect(record.details?.stack).toBeDefined();
      expect(log).not.toContain('private-key');
    } finally {
      await api.conversations.closeAll();
      written.mockRestore();
      await rm(root, { recursive: true, force: true });
    }
  });
});

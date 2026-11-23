import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { readHistoryEntries } from '@sheavly/core/store/history-log.helper';
import { FileConversationStore } from '@sheavly/storage/conversation-store/conversation-store.service';
import { conversationIdSchema } from '@sheavly/protocol/server/server.validator';
import type { Script } from '@sheavly/testing/provider/provider.types';
import { testApi, reply } from '../../testing/api.fake.js';
import { storeLogs } from '../../testing/logs.fake.js';
import { DEEP_ID } from '@sheavly/host/testing/run.fake';

type LoggedLine = {
  event: string;
  seq?: number;
  messageId?: string;
  conversationId?: string;
  modelId?: string;
  error: { message: string; stack?: string; causes: { code?: string }[] };
  details?: { stack?: string; causes: { code?: string }[] };
};

/** A model failure with a cause, as a provider throws it. */
function modelDown(message: string): Script {
  return () => {
    throw new Error(message, {
      cause: Object.assign(new Error('Socket closed'), { code: 'ECONNRESET' }),
    });
  };
}

/** The lines of a conversation's `log.jsonl`, as `jq` would read them. */
async function logLines(params: { root: string; id: string }): Promise<LoggedLine[]> {
  const text = await readFile(
    path.join(params.root, 'conversations', params.id, 'log.jsonl'),
    'utf8',
  );

  return text
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line) as LoggedLine);
}

/**
 * The API over conversations kept in a temporary folder, logging into it as the backend does.
 * `done` closes everything and removes the folder.
 */
async function apiOnDisk(scripts: Record<string, Script[]>) {
  const root = await mkdtemp(path.join(tmpdir(), 'conversation-log-api-'));
  const store = new FileConversationStore({ folder: root, onProblem: () => undefined });
  const api = testApi(scripts, store, undefined, storeLogs(store));
  const done = async () => {
    vi.restoreAllMocks();
    await api.conversations.closeAll();
    await rm(root, { recursive: true, force: true });
  };

  return { root, store, api, done };
}

/** The entries of `event` once the sink has written them: it writes in the background. */
async function loggedEntries(params: { root: string; id: string; event: string }) {
  return vi.waitFor(async () => {
    const found = (await logLines(params)).filter((line) => line.event === params.event);

    expect(found).toHaveLength(1);

    return found;
  });
}

describe('correlated chat diagnostics through the API', () => {
  it('persists each user message ID and links the failed run to the correct message after earlier success', async () => {
    const { root, store, api, done } = await apiOnDisk({
      first: [reply('OK'), modelDown('Model failed apiKey=private-key')],
    });

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
      const [record] = (await logLines({ root, id })).filter((line) => line.event === 'run.failed');
      const text = await readFile(path.join(root, 'conversations', id, 'log.jsonl'), 'utf8');

      expect(users).toHaveLength(2);
      expect(users[0]?.id).toBeDefined();
      expect(users[1]?.id).not.toBe(users[0]?.id);
      expect(record?.messageId).toBe(users[1]?.id);
      expect(record?.conversationId).toBe(id);
      expect(record?.modelId).toBe(DEEP_ID);
      expect(record?.error.message).toBe('Model failed apiKey=[REDACTED]');
      expect(record?.details?.causes[0]?.code).toBe('ECONNRESET');
      expect(record?.details?.stack).toBeDefined();
      expect(text).not.toContain('private-key');
    } finally {
      await done();
    }
  });

  it('logs a prompt that fails in the background once in its conversation’s log, with the cause chain', async () => {
    const { root, api, done } = await apiOnDisk({ boom: [modelDown('model down')] });

    try {
      const id = conversationIdSchema.parse(await api.start());

      // The send is answered at once and the conversation reads the run: only its log tells.
      for await (const _frame of api.runOf({ id, text: 'boom' }));

      const [failed] = await loggedEntries({ root, id, event: 'prompt.failed' });

      expect(failed).toMatchObject({
        conversationId: id,
        error: { message: 'model down', causes: [{ code: 'ECONNRESET' }] },
      });
      expect(failed?.error.stack).toContain('model down');
    } finally {
      await done();
    }
  });

  it('writes an unexpected error in a conversation route to that conversation’s log, and the client gets only internal', async () => {
    const { root, api, done } = await apiOnDisk({ first: [reply('OK')] });

    try {
      const id = conversationIdSchema.parse(await api.start());

      vi.spyOn(api.conversations, 'details').mockRejectedValue(
        new TypeError('broke', { cause: new Error('disk gone') }),
      );

      const response = await api.request(`/conversations/${id}`);
      const [logged] = await loggedEntries({ root, id, event: 'api.request_failed' });

      expect(response.status).toBe(500);
      expect(await response.json()).toEqual({
        error: { code: 'internal', message: 'The server failed; see its log' },
      });
      expect(logged).toMatchObject({
        conversationId: id,
        error: { name: 'TypeError', message: 'broke', causes: [{ message: 'disk gone' }] },
      });
      expect(logged?.error.stack).toBeDefined();
    } finally {
      await done();
    }
  });
});

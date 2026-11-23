import { describe, expect, it } from 'vitest';
import { Conversations } from '@sheavly/host/conversations/conversations.service';
import { useTempFolders } from '@sheavly/testing/files/temp-folders.fake';
import { createApiApp } from '../api.helper.js';
import { testBackend } from '../../testing/backend.fake.js';
import { TEST_INSTANCE_ID } from '../../testing/identity.fake.js';
import { collectingLogs } from '../../testing/logs.fake.js';
import { TEST_SECRET, TEST_SERVER_VERSION, TEST_TOKEN } from '../../testing/testing.constants.js';

const folders = useTempFolders({ prefix: 'internal-failure-log-', names: ['app'] });

/** The backend's API over `pick`'s conversations, with the entries it logged. */
function apiOver(pick: (real: Conversations) => Conversations) {
  const made = testBackend({ home: `${folders.base}/home`, workspace: folders.app });
  const { logs, entries } = collectingLogs();
  const app = createApiApp({
    conversations: pick(made.conversations),
    setup: made.setup,
    workspaces: made.workspaces,
    permissions: made.permissions,
    token: TEST_TOKEN,
    instanceId: TEST_INSTANCE_ID,
    serverVersion: TEST_SERVER_VERSION,
    logs,
  });
  const call = (path: string, init: { method: string; body?: string } = { method: 'GET' }) =>
    app.request(path, {
      ...init,
      headers: { authorization: `Bearer ${TEST_TOKEN}`, 'content-type': 'application/json' },
    });

  return { call, entries };
}

describe('an unexpected failure the API answers as internal', () => {
  it('tells the client nothing and logs one entry with the error, its stack and its route', async () => {
    const failure = new TypeError(`broke at /w/file password=${TEST_SECRET}`);
    const { call, entries } = apiOver(
      () =>
        new Conversations({
          create: () => {
            throw failure;
          },
        }),
    );
    const response = await call('/conversations', { method: 'POST', body: '{}' });
    const text = await response.text();

    expect(response.status).toBe(500);
    expect(JSON.parse(text)).toEqual({
      error: { code: 'internal', message: 'The server failed; see its log' },
    });
    expect(text).not.toContain('SECRET');
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({
      level: 'error',
      event: 'api.request_failed',
      route: 'POST /conversations',
      status: 500,
      error: { name: 'TypeError' },
    });
    expect((entries[0]?.error as { stack: string }).stack).toContain('internal-failure-log.test');
    expect(JSON.stringify(entries)).not.toContain(TEST_SECRET);
  });

  it('logs nothing for a failure the client caused', async () => {
    const { call, entries } = apiOver((real) => real);
    const response = await call('/conversations/00000000-0000-4000-8000-0000000000ab');

    expect(response.status).toBe(404);
    expect(entries).toEqual([]);
  });
});

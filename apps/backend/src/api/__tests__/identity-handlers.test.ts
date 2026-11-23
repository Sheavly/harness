import { describe, expect, it } from 'vitest';
import { newNonce } from '@sheavly/protocol/handshake/handshake.utils';
import { TEST_INSTANCE_ID } from '../../testing/identity.fake.js';
import { collectingLogs } from '../../testing/logs.fake.js';
import { TEST_SERVER_VERSION, TEST_TOKEN } from '../../testing/testing.constants.js';
import { createApiApp } from '../api.helper.js';

/**
 * A collaborator whose every method fails when called: whatever uses it shows up as a 500. Typed
 * `never` so it stands in for any collaborator.
 */
function throwing(): never {
  return new Proxy(
    {},
    {
      get: () => () => {
        throw new Error('a public route reached a collaborator');
      },
    },
  ) as never;
}

describe('the public routes', () => {
  it('answer while every collaborator throws, so they reach no conversation, setup, folder or permission', async () => {
    const { logs, entries } = collectingLogs();
    const app = createApiApp({
      conversations: throwing(),
      setup: throwing(),
      workspaces: throwing(),
      permissions: throwing(),
      token: TEST_TOKEN,
      instanceId: TEST_INSTANCE_ID,
      serverVersion: TEST_SERVER_VERSION,
      logs,
    });
    const health = await app.request('/health');
    const handshake = await app.request('/handshake', {
      method: 'QUERY',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ nonce: newNonce() }),
    });

    expect(health.status).toBe(200);
    expect(handshake.status).toBe(200);
    expect(entries).toEqual([]);
  });
});

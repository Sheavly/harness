import { describe, expect, it } from 'vitest';
import { serverErrorSchema } from '@sheavly/protocol/server/server.validator';
import { readChannel } from '@sheavly/runtime/testing/stored-channels.fake';
import { reply, testApi } from './api.fake.js';
import type { useOpenedServers } from './opened-servers.fake.js';
import { servedConversation } from './served-conversation.fake.js';

type Served = Awaited<ReturnType<typeof servedConversation>>;

/**
 * What `GET /conversations/:id/<route>` answers for a conversation that is not there, one that was
 * closed, and one on a host that keeps nothing: the three statuses, and the error code of the last.
 * Closes `world`'s conversation.
 */
async function answersForAbsentConversations(params: { world: Served; route: string }) {
  const { world, route } = params;
  const keepsNothing = testApi({ go: [reply('done')] });
  const unkept = await keepsNothing.start();
  const answers = [
    await world.api.request(`/conversations/00000000-0000-4000-8000-000000000000/${route}`),
    await keepsNothing.request(`/conversations/${unkept}/${route}`),
  ];

  await world.api.request(`/conversations/${world.id}`, { method: 'DELETE' });
  answers.push(await world.api.request(`/conversations/${world.id}/${route}`));

  return {
    statuses: answers.map(({ status }) => status),
    code: serverErrorSchema.parse(await answers[1]?.json()).error.code,
  };
}

/**
 * Leaves the channel `channel` of `world`'s conversation with an entry no client could read,
 * reopens the conversation on a host over the same store, and answers what
 * `GET /conversations/:id/<route>` says then: the reopen's status, the answer's, and its error code.
 */
async function answerAfterUnreadableChannel(params: {
  world: Served;
  channel: string;
  route: string;
}) {
  const { world, channel, route } = params;
  const stored = await readChannel({ store: world.store, id: world.conversation, channel });

  await world.store.channel({ id: world.conversation, channel }).append({
    channel,
    cursor: `s${String(stored.length)}`,
    at: 1,
    type: 'note',
  });

  const reopened = testApi({ go: [reply('done')] }, world.store);
  const reopen = await reopened.request(`/stored-conversations/${world.id}/reopen`, {
    method: 'POST',
  });
  const answer = await reopened.request(`/conversations/${world.id}/${route}`);

  return {
    reopened: reopen.status,
    status: answer.status,
    code: serverErrorSchema.parse(await answer.json()).error.code,
  };
}

/**
 * Test-only: the tests of how a route that serves one of a conversation's own channels refuses:
 * the same three for the tree and for usage, so a route added for another is one more call. `route`
 * is the path after `/conversations/:id/`, `channel` the name of the channel it serves. `servers` is
 * the test file's `useOpenedServers()`.
 */
export function describeChannelRouteRefusals(params: {
  route: string;
  channel: string;
  servers: ReturnType<typeof useOpenedServers>;
}) {
  const { route, channel, servers } = params;

  describe(`what the ${route} route refuses`, () => {
    it('is not found for a conversation that is not there, one that was closed, and a host that keeps nothing', async () => {
      const world = await servedConversation({ servers });
      const absent = await answersForAbsentConversations({ world, route });

      expect(absent.statuses).toEqual([404, 404, 404]);
      expect(absent.code).toBe('not_found');
    });

    it('wants the token, as every route does', async () => {
      const world = await servedConversation({ servers });
      const response = await world.api.app.request(`/conversations/${world.id}/${route}`);

      expect(response.status).toBe(401);
    });

    it(`is 507 when the conversation’s ${channel} channel could not be stored, saying so`, async () => {
      const world = await servedConversation({ servers });
      // The conversation still reopens; the channel is refused rather than served as if current.
      const after = await answerAfterUnreadableChannel({ world, channel, route });

      expect(after).toEqual({ reopened: 200, status: 507, code: 'storage_failed' });
    });
  });
}

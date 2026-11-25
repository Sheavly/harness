import { createClient } from '@sheavly/client/client/client.helper';
import { conversationIdSchema } from '@sheavly/protocol/server/server.validator';
import { MemoryConversationStore } from '@sheavly/testing/store/memory-store.fake';
import { reply, testApi } from './api.fake.js';
import type { useOpenedServers } from './opened-servers.fake.js';
import { TEST_TOKEN } from './testing.constants.js';

/**
 * Test-only: a conversation that ran one prompt, kept in a store, served on a real port (`client`)
 * and in-process (`api`, the same app), with what its node channels and its tree channel were told
 * written. `servers` is the test file's `useOpenedServers()`.
 */
export async function servedConversation(params: {
  servers: ReturnType<typeof useOpenedServers>;
  store?: MemoryConversationStore;
}) {
  const store = params.store ?? new MemoryConversationStore();
  const api = testApi({ go: [reply('done')] }, store);
  const url = await params.servers.listen(api.app.fetch);
  const client = createClient({ url, token: TEST_TOKEN });
  const id = await api.start();

  for await (const _frame of api.runOf({ id, text: 'go' }));

  const conversation = conversationIdSchema.parse(id);
  const { harness } = api.conversations.get(conversation);

  await harness.nodeChannels?.flush();
  await harness.treeChannel?.flush();

  return { api, store, client, id, conversation, harness };
}

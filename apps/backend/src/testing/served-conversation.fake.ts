import { createClient } from '@sheavly/client/client/client.helper';
import type { ConversationStore } from '@sheavly/core/store/store.types';
import { conversationIdSchema } from '@sheavly/protocol/server/server.validator';
import type { Script } from '@sheavly/testing/provider/provider.types';
import { MemoryConversationStore } from '@sheavly/testing/store/memory-store.fake';
import { reply, testApi } from './api.fake.js';
import type { useOpenedServers } from './opened-servers.fake.js';
import { TEST_TOKEN } from './testing.constants.js';

/**
 * Test-only: a conversation that ran one prompt, kept in a store, served on a real port (`client`)
 * and in-process (`api`, the same app), with what its node channels, its tree channel and its usage
 * channel were told written. `servers` is the test file's `useOpenedServers()`. `replies` are the
 * model's turns for the prompts sent to it (a plain answer, by default).
 */
export async function servedConversation(params: {
  servers: ReturnType<typeof useOpenedServers>;
  store?: ConversationStore;
  replies?: Script[];
}) {
  const store = params.store ?? new MemoryConversationStore();
  const api = testApi({ go: params.replies ?? [reply('done')] }, store);
  const url = await params.servers.listen(api.app.fetch);
  const client = createClient({ url, token: TEST_TOKEN });
  const id = await api.start();

  for await (const _frame of api.runOf({ id, text: 'go' }));

  const conversation = conversationIdSchema.parse(id);
  const { harness } = api.conversations.get(conversation);

  await harness.nodeChannels?.flush();
  await harness.treeChannel?.flush();
  await harness.usageChannel?.flush();

  return { api, store, client, url, id, conversation, harness };
}

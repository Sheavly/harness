import { serve } from '@hono/node-server';
import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import { describe, expect, it } from 'vitest';
import { watchApprovals } from '@sheavly/client/approvals/approvals.helper';
import { createClient } from '@sheavly/client/client/client.helper';
import { promptEntries } from '@sheavly/client/prompt/prompt.helper';
import { conversationIdSchema } from '@sheavly/protocol/server/server.validator';
import { toolCall } from '@sheavly/testing/provider/routed-provider.fake';
import { reply, testApi } from '../../testing/api.fake.js';
import { useOpenedServers } from '../../testing/opened-servers.fake.js';
import { TEST_TOKEN } from '../../testing/testing.constants.js';

// A conversation's history is replayed to the client that answers approvals, on every connect. An
// entry whose text holds U+2028 or U+2029 (JSON leaves both unescaped) must not stop that stream:
// with nobody listening, a command that needs approval is refused instead of asked.

const asks = () => [
  toolCall({ id: 'c1', name: 'ask', input: {} }),
  { type: 'done' as const, stopReason: 'tool_use' as const },
];

const servers = useOpenedServers();

describe('approvals over a replayed history that holds line separators', () => {
  it('are still asked, and answered, by a client that replays the history', async () => {
    const api = testApi({ go: [asks, reply('done')] });
    const server = serve({ fetch: api.app.fetch, hostname: '127.0.0.1', port: 0 });

    servers.add(server);
    await once(server, 'listening');

    const url = `http://127.0.0.1:${String((server.address() as AddressInfo).port)}`;
    const client = createClient({ url, token: TEST_TOKEN });
    const { id } = await client.call('startConversation', { body: {} });
    const { sessions, mainSession } = api.conversations.get(conversationIdSchema.parse(id)).harness;
    const heard: string[] = [];
    const replayed: string[] = [];
    const answers: Promise<unknown>[] = [];
    const stop = new AbortController();
    const separators = 'before\u2028middle\u2029after';

    // Made before the watcher opens, so it is part of what the watcher replays.
    sessions.publish({
      sessionId: mainSession.id,
      event: { seq: 0, type: 'text_delta', text: separators },
    });

    const { ended } = await watchApprovals({
      client,
      id,
      signal: stop.signal,
      onEntry: (entry) => {
        if (entry.kind === 'event' && entry.event.type === 'text_delta') {
          replayed.push(entry.event.text);
        }
      },
      onApproval: ({ update }) => {
        if (update.type !== 'approval_requested') return;

        heard.push(update.request.id);
        answers.push(
          client.send('answerApproval', {
            id,
            approval: update.request.id,
            body: { response: { decision: 'approve' } },
          }),
        );
      },
    });

    try {
      // The prompt only ends once the approval was answered, so what was heard is final here.
      for await (const _entry of promptEntries({ client, id, prompt: { text: 'go' } }));
      await Promise.all(answers);

      expect(replayed).toContain(separators);
      expect(heard).toHaveLength(1);
    } finally {
      // A failure above must not leave the watcher reconnecting to a server that is closing.
      stop.abort();
      await ended;
      await api.conversations.closeAll();
    }
  });
});

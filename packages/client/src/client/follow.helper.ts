import type { ConversationId } from '@sheavly/protocol/server/server.types';
import type { StreamEntry } from '@sheavly/protocol/stream/stream.types';
import type { createClient } from './client.helper.js';
import type { CallParams } from './client.types.js';
import { reconnectingEntries } from './reconnect.helper.js';

/**
 * Follows conversation `id`'s stream as `body` asks (`QUERY /conversations/:id/stream`): a dropped
 * connection is reopened after the last entry heard (`reconnectingEntries`), so each entry comes
 * once. Resolves once the backend has accepted the first connection, so what the caller does next
 * is in it. The entries end when `signal` aborts, and throw `StreamLostError` when it gives up.
 */
export async function followConversation(params: {
  client: ReturnType<typeof createClient>;
  id: ConversationId;
  body: CallParams<'streamConversation'>['body'];
  signal: AbortSignal;
}): Promise<AsyncGenerator<StreamEntry>> {
  const { client, id, body, signal } = params;
  const open = (lastEventId?: number) =>
    client.open('streamConversation', {
      id,
      body,
      signal,
      ...(lastEventId !== undefined && { lastEventId }),
    });
  // Opened here so the caller knows the backend accepted it; a reconnect opens its own.
  let first: ReadableStream<Uint8Array> | undefined = await open();

  return reconnectingEntries({
    signal,
    endless: true,
    ...client.reconnect,
    open: ({ lastEventId }) => {
      const body = first;

      first = undefined;

      return body ? Promise.resolve(body) : open(lastEventId);
    },
  });
}

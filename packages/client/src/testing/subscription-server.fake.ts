import type { SubscribeFrame } from '@sheavly/protocol/subscription/subscription.types';
import { subscribeRequestSchema } from '@sheavly/protocol/subscription/subscription.validator';
import { createClient } from '../client/client.helper.js';
import type { ReconnectPolicy } from '../client/client.types.js';
import { fakeServer } from './fake-server.fake.js';
import type { FakeCall, FakeRefusal, SentFrames, ServedSubscription } from './testing.types.js';

/** Test-only: a connection that drops where it is put in a connection's frames. */
export const DROP = new TypeError('terminated');

async function* sends(frames: SentFrames): AsyncGenerator<SubscribeFrame> {
  for (const item of frames) {
    if (item instanceof Error) throw item;

    yield item;
  }
}

/**
 * Test-only: a backend that answers the n-th subscribe request with the n-th of `connections` (a
 * refusal, or what it sends, ending cleanly after the last frame), a `503` once they run out, and a
 * client for it. The client waits only for the event loop's turn between attempts and gives up after
 * a few, so a loop that would never end fails a test instead of spinning on promises and hanging the
 * run past any timeout.
 */
export function served(params: {
  connections: (SentFrames | FakeRefusal)[];
  reconnect?: ReconnectPolicy;
}): ServedSubscription {
  let opened = 0;
  const { fetch, calls } = fakeServer({
    streamChannels: () => {
      const connection = params.connections[opened];

      opened += 1;

      if (!connection) return { refuse: { status: 503, code: 'internal' } };

      return Array.isArray(connection) ? sends(connection) : connection;
    },
  });
  const client = createClient({
    url: 'http://backend.test',
    token: 't',
    fetch,
    reconnect: {
      wait: () => new Promise((resolve) => setTimeout(resolve, 0)),
      attempts: 6,
      ...params.reconnect,
    },
  });

  return {
    client,
    asked: () =>
      calls.map(({ call }: { call: FakeCall }) => subscribeRequestSchema.parse(call.body)),
  };
}

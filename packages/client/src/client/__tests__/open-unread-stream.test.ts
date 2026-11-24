import { setFlagsFromString } from 'node:v8';
import { runInNewContext } from 'node:vm';
import { afterEach, describe, expect, it } from 'vitest';
import { conversationIdSchema } from '@sheavly/protocol/server/server.validator';
import type { Impostor } from '../../testing/testing.types.js';
import { startImpostor } from '../../testing/impostor-server.fake.js';
import { createClient } from '../client.helper.js';

const ID = conversationIdSchema.parse('00000000-0000-4000-8000-0000000000ab');
const FRAME = 'event: other\ndata: {}\n\n';

/** Collects garbage on demand without needing `--expose-gc` on the test runner. */
function collectGarbage(): void {
  setFlagsFromString('--expose-gc');
  (runInNewContext('gc') as () => void)();
}

const pause = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

let server: Impostor | undefined;

afterEach(async () => {
  await server?.close();
  server = undefined;
});

/** A server whose stream says its head at once and sends one frame shortly after. */
async function slowStream(): Promise<string> {
  server = await startImpostor((_request, response) => {
    response.writeHead(200, { 'content-type': 'text/event-stream' });
    response.write(': head\n\n');

    const timer = setTimeout(() => response.write(FRAME), 150);

    response.on('close', () => clearTimeout(timer));
  });

  return server.url;
}

describe('a stream opened and not read yet', () => {
  it('is still open, and delivers what the server sends, after a garbage collection', async () => {
    const client = createClient({ url: await slowStream(), token: 'secret' });
    const body = await client.open('streamConversation', { id: ID, body: {} });

    // A prompt opens its stream, sends, and reads after: nothing holds the response meanwhile.
    for (let round = 0; round < 3; round += 1) {
      await pause(20);
      collectGarbage();
    }

    await pause(200);

    const reader = body.getReader();
    let text = '';

    while (!text.includes(FRAME)) {
      const read = await reader.read();

      // The failure this guards: fetch cancelled the unread body, so the first read is the end.
      expect(read.done).toBe(false);
      text += new TextDecoder().decode(read.value);
    }

    await reader.cancel();
  });

  it('locks the response body it was given, which is what keeps fetch from cancelling it', async () => {
    const upstream = new Response(new ReadableStream<Uint8Array>());
    const client = createClient({
      url: 'http://unused.test',
      token: 'secret',
      fetch: () => Promise.resolve(upstream),
    });

    await client.open('streamConversation', { id: ID, body: {} });

    expect(upstream.body?.locked).toBe(true);
  });
});

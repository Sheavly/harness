import { describe, expect, it } from 'vitest';
import { ConnectionLostError } from '@sheavly/core/errors/connection.errors';
import { collect } from '@sheavly/testing/fetch/fake-fetch.fake';
import { createResponsesProvider } from '../../responses/responses.helper.js';
import { TEST_REQUEST } from '../../testing/request.constants.js';

/** A reply whose connection drops after one event, as a cut network does mid-stream. */
function droppedMidStream(): Response {
  const encoder = new TextEncoder();
  let sent = false;
  const body = new ReadableStream<Uint8Array>({
    pull(controller) {
      if (sent) {
        controller.error(new TypeError('terminated'));

        return;
      }

      sent = true;
      controller.enqueue(
        encoder.encode(
          `data: ${JSON.stringify({ type: 'response.output_text.delta', delta: 'par' })}\n\n`,
        ),
      );
    },
  });

  return new Response(body, { headers: { 'content-type': 'text/event-stream' } });
}

describe('a failure after the reply started streaming', () => {
  it('is not retried by the provider, however many retries the policy allows', async () => {
    let calls = 0;
    const fetch: typeof globalThis.fetch = () => {
      calls++;

      return Promise.resolve(droppedMidStream());
    };
    const provider = createResponsesProvider({
      endpoint: { baseUrl: 'https://example.test/v1', model: 'm', headers: {} },
      request: { ...TEST_REQUEST, retries: 5, retryDelayMs: 0 },
      fetch,
    });
    const seen: unknown[] = [];

    await expect(
      (async () => {
        for await (const event of provider.stream({
          messages: [{ role: 'user', content: 'hi' }],
          tools: [],
          signal: new AbortController().signal,
        })) {
          seen.push(event);
        }
      })(),
    ).rejects.toBeInstanceOf(ConnectionLostError);

    expect(calls).toBe(1);
    expect(seen).toEqual([{ type: 'text_delta', text: 'par' }]);
  });

  it('is still retried when the failure comes before the response starts', async () => {
    let calls = 0;
    const fetch: typeof globalThis.fetch = () => {
      calls++;

      return calls === 1
        ? Promise.resolve(new Response('busy', { status: 503 }))
        : Promise.resolve(
            new Response(
              `data: ${JSON.stringify({ type: 'response.completed', response: {} })}\n\n`,
            ),
          );
    };
    const provider = createResponsesProvider({
      endpoint: { baseUrl: 'https://example.test/v1', model: 'm', headers: {} },
      request: { ...TEST_REQUEST, retries: 2, retryDelayMs: 0 },
      fetch,
    });

    const events = await collect(
      provider.stream({
        messages: [{ role: 'user', content: 'hi' }],
        tools: [],
        signal: new AbortController().signal,
      }),
    );

    expect(calls).toBe(2);
    expect(events.at(-1)).toMatchObject({ type: 'done' });
  });
});

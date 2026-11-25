import { describe, expect, it } from 'vitest';
import { fakeFetch, fakeFetchSequence } from '@sheavly/testing/fetch/fake-fetch.fake';
import { AdapterError } from '../../errors/providers.errors.js';
import { createDefaultRegistry } from '../default-registry.helper.js';
import { CHECK_MESSAGES } from '../registry.constants.js';
import { CHECK_PROMPT } from '../registry.prompt.js';

/** A key no other string in a request or a result could be: finding it means it leaked. */
const KEY = 'sk-LEAK-CHECK-9f3a71c2';
const config = { apiKey: KEY, model: 'gpt-6' };
const registryOn = (fetch: typeof globalThis.fetch) => createDefaultRegistry({ fetch });
const answered = [{ type: 'response.output_text.delta', delta: 'OK' }];

/** A fetch answering every call with this HTTP status and a body, which may echo the key. */
const answeringWith = (params: { status: number; body?: string }) => {
  const requests: Request[] = [];
  const fetch = (async (url: string | URL | Request, init?: RequestInit) => {
    requests.push(new Request(url, init));

    return new Response(params.body ?? 'nope', { status: params.status });
  }) as typeof globalThis.fetch;

  return { fetch, requests };
};

/** A fetch that never answers, and fails when its caller aborts, as a real one does. */
const silent = ((_url: string | URL | Request, init?: RequestInit) =>
  new Promise((_resolve, reject) => {
    init?.signal?.addEventListener('abort', () => reject(init.signal?.reason as Error));
  })) as typeof globalThis.fetch;

describe('AdapterRegistry.check', () => {
  it('is valid when the model answers, after one call carrying the question and the key', async () => {
    const { fetch, requests } = fakeFetch(answered);
    const result = await registryOn(fetch).check({ kind: 'openai', config });

    expect(result).toEqual({ status: 'valid' });
    expect(CHECK_PROMPT).toBe('Reply with the single word OK.');
    expect(requests).toHaveLength(1);
    expect(requests[0]?.headers.authorization).toBe(`Bearer ${KEY}`);
    expect(JSON.stringify(requests[0]?.body)).toContain(CHECK_PROMPT);
    expect(requests[0]?.body).toMatchObject({ model: 'gpt-6' });
  });

  it('is valid at the first thing the model says, without waiting for the rest', async () => {
    const encoder = new TextEncoder();
    const endless = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(
          encoder.encode(
            `data: ${JSON.stringify({ type: 'response.output_text.delta', delta: 'O' })}\n\n`,
          ),
        );
        // Never closed: a check that waited for the end would hang here.
      },
    });
    const fetch = (async () => new Response(endless)) as unknown as typeof globalThis.fetch;

    expect(
      await registryOn(fetch).check({ kind: 'openai', config, responseTimeoutMs: 2000 }),
    ).toEqual({ status: 'valid' });
  });

  it.each([
    [401, 'invalid'],
    [403, 'invalid'],
    [404, 'not_found'],
    [400, 'rejected'],
    [422, 'rejected'],
    [429, 'rejected'],
    [500, 'unreachable'],
    [503, 'unreachable'],
  ] as const)('reads an HTTP %i as %s', async (status, expected) => {
    const { fetch, requests } = answeringWith({ status });
    const result = await registryOn(fetch).check({ kind: 'openai', config });

    expect(result).toMatchObject({ status: expected });

    if (status === 400 || status === 422 || status === 429) {
      expect(result).toMatchObject({
        message: expect.stringContaining(`HTTP ${String(status)}`) as string,
      });
    } else {
      expect(result).toEqual({ status: expected, message: CHECK_MESSAGES[expected] });
    }

    // A check that is wrong says so at once: it is never retried.
    expect(requests).toHaveLength(1);
  });

  it('never sends back what the provider said, so a key it echoed can’t come out', async () => {
    for (const status of [400, 401, 404, 429, 500]) {
      const { fetch } = answeringWith({ status, body: `bad key ${KEY} for model gpt-6` });
      const result = await registryOn(fetch).check({ kind: 'openai', config });

      expect(JSON.stringify(result), String(status)).not.toContain(KEY);
      expect(JSON.stringify(result), String(status)).not.toContain('gpt-6');
    }
  });

  it('reads a request that never reached the provider as unreachable', async () => {
    const fetch = (async () => {
      throw new TypeError('fetch failed');
    }) as unknown as typeof globalThis.fetch;

    expect(await registryOn(fetch).check({ kind: 'openai', config })).toEqual({
      status: 'unreachable',
      message: CHECK_MESSAGES.unreachable,
    });
  });

  it('explains adaptive-thinking and output-limit refusals without echoing provider data', async () => {
    for (const [body, explanation] of [
      [
        `thinking.type enabled is not supported; use adaptive. ${KEY}`,
        'requires adaptive thinking',
      ],
      [`max_tokens exceeds the supported maximum. ${KEY}`, 'output limit per reply'],
    ] as const) {
      const { fetch } = answeringWith({ status: 400, body });
      const result = await registryOn(fetch).check({ kind: 'openai', config });

      expect(result).toMatchObject({
        status: 'rejected',
        message: expect.stringContaining(explanation) as string,
      });
      expect(JSON.stringify(result)).not.toContain(KEY);
    }
  });

  it('reads a provider that never starts answering as unreachable, once its time is up', async () => {
    const result = await registryOn(silent).check({
      kind: 'openai',
      config,
      responseTimeoutMs: 20,
    });

    expect(result).toEqual({ status: 'unreachable', message: CHECK_MESSAGES.unreachable });
  });

  it('reads an error in the reply as rejected', async () => {
    const { fetch } = fakeFetchSequence({
      responses: [[{ type: 'response.failed', response: { error: { message: 'no' } } }]],
    });

    expect(await registryOn(fetch).check({ kind: 'openai', config })).toMatchObject({
      status: 'rejected',
    });
  });

  it('rejects when the caller gives up, which is not an answer', async () => {
    const caller = new AbortController();
    const pending = registryOn(silent).check({ kind: 'openai', config, signal: caller.signal });

    caller.abort(new Error('closed the dialog'));
    await expect(pending).rejects.toThrow('closed the dialog');
  });

  it('rejects a config the adapter does not take, and an adapter it does not have', async () => {
    const { fetch } = fakeFetch(answered);
    const registry = registryOn(fetch);

    await expect(registry.check({ kind: 'openai', config: { apiKey: KEY } })).rejects.toThrow(
      AdapterError,
    );
    await expect(registry.check({ kind: 'nope', config })).rejects.toThrow('Unknown adapter: nope');
  });

  it('uses the check’s own request policy, not whatever the config says', async () => {
    const { fetch, requests } = answeringWith({ status: 503 });
    const sentWith = {
      ...config,
      request: {
        responseTimeoutMs: 5,
        retries: 9,
        retryDelayMs: 1,
        offlineTimeoutMs: 3_600_000,
        probeUrls: ['https://probe.test'],
      },
    };

    await registryOn(fetch).check({ kind: 'openai', config: sentWith });
    expect(requests).toHaveLength(1);
  });
});

import { describe, expect, it, vi } from 'vitest';
import { collect, fakeFetch } from '@sheavly/testing/fetch/fake-fetch.fake';
import type { ProviderRequest } from '@sheavly/core/provider/provider.types';
import { ModelApiError } from '../../errors/providers.errors.js';
import type { RequestPolicy } from '../../http/http.types.js';
import { createResponsesProvider } from '../responses.helper.js';

const COMPLETED = [
  { type: 'response.output_text.delta', delta: 'ok' },
  { type: 'response.completed', response: {} },
];
const policy = (fields: Partial<RequestPolicy> = {}): RequestPolicy => ({
  responseTimeoutMs: 1000,
  retries: 2,
  retryDelayMs: 0,
  offlineTimeoutMs: 0,
  probeUrls: [],
  ...fields,
});

/** A `fetch` that answers each call with the next of `replies`, and counts them. */
function scriptedFetch(replies: (() => Promise<Response>)[]) {
  const calls = { count: 0 };
  const { fetch: completed } = fakeFetch(COMPLETED);
  const fetch: typeof globalThis.fetch = (input, init) => {
    const reply = replies[calls.count];

    calls.count++;

    return reply ? reply() : completed(input, init);
  };

  return { fetch, calls };
}

/** A request that never gets a response, until its signal aborts it, as Node's fetch does. */
const hangs = (init?: RequestInit) => () =>
  new Promise<Response>((_, reject) => {
    init?.signal?.addEventListener('abort', () => {
      reject(new DOMException('aborted', 'AbortError'));
    });
  });
const dropped = () => () =>
  Promise.reject(
    new TypeError('fetch failed', {
      cause: Object.assign(new Error('other side closed'), { code: 'UND_ERR_SOCKET' }),
    }),
  );
const status =
  (code: number, headers: Record<string, string> = {}) =>
  () =>
    Promise.resolve(new Response('busy', { status: code, headers }));

const run = (params: {
  fetch: typeof globalThis.fetch;
  request?: RequestPolicy;
  signal?: AbortSignal;
}) => {
  const { fetch, request = policy(), signal = new AbortController().signal } = params;
  const sent: ProviderRequest = { messages: [{ role: 'user', content: 'hi' }], tools: [], signal };

  return collect(
    createResponsesProvider({
      endpoint: { baseUrl: 'https://example.test/v1', model: 'm', headers: {} },
      request,
      fetch,
    }).stream(sent),
  );
};

describe('sending a Responses call', () => {
  it('retries a dropped connection and a 5xx, then streams the reply as usual', async () => {
    const { fetch, calls } = scriptedFetch([dropped(), status(503)]);

    await expect(run({ fetch })).resolves.toContainEqual({ type: 'text_delta', text: 'ok' });
    expect(calls.count).toBe(3);
  });

  it('streams what it says about the connection before the reply, and keeps it out of the reply', async () => {
    // The model call is dropped, then the probe fails too (the second fetch), so the call waits.
    const { fetch } = scriptedFetch([dropped(), dropped()]);

    // The wait while offline is a second at least: its timers are fake, so the test is not.
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });

    const running = run({
      fetch,
      request: policy({ offlineTimeoutMs: 3_600_000, probeUrls: ['https://probe.test'] }),
    });

    await vi.runAllTimersAsync();
    vi.useRealTimers();

    const events = await running;

    expect(events.slice(0, 2)).toMatchObject([
      { type: 'model_connection', connection: { state: 'offline' } },
      { type: 'model_connection', connection: { state: 'restored' } },
    ]);
    expect(events.at(-1)).toMatchObject({ type: 'done' });
  });

  it('gives up after its retries, naming the reason and keeping the cause', async () => {
    const { fetch, calls } = scriptedFetch([dropped(), dropped(), dropped()]);
    const failure = await run({ fetch }).catch((caughtError: unknown) => caughtError);

    expect(calls.count).toBe(3);
    expect(failure).toBeInstanceOf(ModelApiError);
    expect(failure).toMatchObject({ reason: 'network' });
    expect((failure as Error).message).toContain('UND_ERR_SOCKET: other side closed');
    expect((failure as Error).message).toContain('after 3 attempts');
  });

  it("times out a response that never starts, and doesn't retry a 4xx", async () => {
    const pending = scriptedFetch([]);
    const timedOut = await run({
      fetch: (_input, init) => hangs(init)(),
      request: policy({ responseTimeoutMs: 20, retries: 0 }),
    }).catch((caughtError: unknown) => caughtError);
    const { fetch, calls } = scriptedFetch([status(400)]);
    const refused = await run({ fetch }).catch((caughtError: unknown) => caughtError);

    expect(pending.calls.count).toBe(0);
    expect(timedOut).toMatchObject({ reason: 'timeout' });
    expect((timedOut as Error).message).toContain('within 20ms');
    expect(refused).toMatchObject({ reason: 'http', status: 400 });
    expect(calls.count).toBe(1);
  });

  it('waits at least what the server asks for in retry-after', async () => {
    const { fetch } = scriptedFetch([status(429, { 'retry-after': '0.05' })]);
    const started = performance.now();

    await run({ fetch });

    expect(performance.now() - started).toBeGreaterThanOrEqual(45);
  });

  it('reports at once a retry-after too long to wait for, instead of hanging the run', async () => {
    const { fetch, calls } = scriptedFetch([status(429, { 'retry-after': '86400' })]);
    const failure = await run({ fetch }).catch((caughtError: unknown) => caughtError);

    expect(failure).toMatchObject({ reason: 'http', status: 429 });
    expect(calls.count).toBe(1);
  });

  it('stops at once when the run is interrupted, without retrying or renaming it', async () => {
    const controller = new AbortController();
    const { fetch, calls } = scriptedFetch([status(503)]);
    const running = run({
      fetch,
      request: policy({ retryDelayMs: 10_000 }),
      signal: controller.signal,
    }).catch((caughtError: unknown) => caughtError);

    controller.abort();

    expect(await running).not.toBeInstanceOf(ModelApiError);
    expect(calls.count).toBe(1);
  });
});

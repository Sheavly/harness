import { describe, expect, it } from 'vitest';
import { TEST_REQUEST } from '../../testing/request.constants.js';
import { sendCollecting } from '../../testing/send.fake.js';
import type { RequestSigner } from '../http.types.js';

const policy = { ...TEST_REQUEST, responseTimeoutMs: 1000, retries: 2 };
const url = new URL('https://signed.test/v1/messages');
const init = {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: '{"a":1}',
};

/** A fetch that answers each call with the next status, recording the headers it was sent. */
function fetchAnswering(statuses: number[]) {
  const sent: Record<string, string>[] = [];
  const fetch = (async (_url: URL, request?: RequestInit) => {
    sent.push(request?.headers as Record<string, string>);

    return new Response('ok', { status: statuses.shift() ?? 200 });
  }) as unknown as typeof globalThis.fetch;

  return { fetch, sent };
}

const send = (params: { fetch: typeof globalThis.fetch; sign?: RequestSigner; body?: string }) =>
  sendCollecting({
    api: 'Test API',
    fetch: params.fetch,
    url,
    init: { ...init, body: params.body ?? init.body },
    policy,
    signal: new AbortController().signal,
    sign: params.sign,
  });

describe('sendRequest with a signer', () => {
  it('signs the call from its headers and body, and sends the signature with them', async () => {
    const { fetch, sent } = fetchAnswering([200]);
    const seen: Parameters<RequestSigner>[0][] = [];

    await send({
      fetch,
      sign: (request) => {
        seen.push(request);

        return { authorization: 'signed' };
      },
    });

    expect(seen).toEqual([{ method: 'POST', url, headers: init.headers, body: '{"a":1}' }]);
    expect(sent).toEqual([{ 'content-type': 'application/json', authorization: 'signed' }]);
  });

  it('signs every attempt anew: a retry carries its own signature, not the first one’s', async () => {
    const { fetch, sent } = fetchAnswering([503, 429, 200]);
    let count = 0;

    await send({ fetch, sign: () => ({ 'x-signature': String(++count) }) });

    expect(sent.map((headers) => headers['x-signature'])).toEqual(['1', '2', '3']);
  });

  it('sends the call as it is without a signer', async () => {
    const { fetch, sent } = fetchAnswering([200]);

    await send({ fetch });

    expect(sent).toEqual([{ 'content-type': 'application/json' }]);
  });

  it('refuses to sign what a signature cannot cover, without sending anything', async () => {
    const { fetch, sent } = fetchAnswering([200]);
    const unsigned = sendCollecting({
      api: 'Test API',
      fetch,
      url,
      init: { method: 'POST', headers: new Headers(), body: new Uint8Array() },
      policy,
      signal: new AbortController().signal,
      sign: () => ({}),
    });

    await expect(unsigned).rejects.toThrow('plain headers and a string body');
    expect(sent).toEqual([]);
  });

  it('refuses a signature that repeats a header the request has, in any capitals, sending nothing', async () => {
    const { fetch, sent } = fetchAnswering([200]);

    await expect(send({ fetch, sign: () => ({ 'Content-Type': 'text/plain' }) })).rejects.toThrow(
      'repeats a header',
    );
    expect(sent).toEqual([]);
  });
});

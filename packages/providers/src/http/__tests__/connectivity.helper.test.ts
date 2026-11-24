import { describe, expect, it } from 'vitest';
import { internetReachable } from '../connectivity.helper.js';

const urls = ['https://one.test/', 'https://two.test/'];
const signal = () => new AbortController().signal;

/** A fetch that answers the addresses in `answers` with a status and fails every other one. */
function answering(answers: Record<string, number>) {
  const asked: { url: string; method: string | undefined }[] = [];
  const fetch = ((input: string, init?: RequestInit) => {
    asked.push({ url: input, method: init?.method });
    const status = answers[input];

    return status === undefined
      ? Promise.reject(new TypeError('fetch failed'))
      : Promise.resolve(new Response(null, { status }));
  }) as typeof globalThis.fetch;

  return { fetch, asked };
}

describe('whether the internet is reachable', () => {
  it('is true when any address answers, even one that fails', async () => {
    const { fetch } = answering({ 'https://two.test/': 200 });

    await expect(internetReachable({ urls, fetch, signal: signal() })).resolves.toBe(true);
  });

  it.each([204, 403, 500])(
    'counts an answer with status %i, since the path is up',
    async (code) => {
      const { fetch } = answering({ 'https://one.test/': code });

      await expect(internetReachable({ urls, fetch, signal: signal() })).resolves.toBe(true);
    },
  );

  it('is false when every address fails', async () => {
    const { fetch } = answering({});

    await expect(internetReachable({ urls, fetch, signal: signal() })).resolves.toBe(false);
  });

  it('asks every address for its headers only: no body, no headers of its own, no redirect followed', async () => {
    const inits: RequestInit[] = [];
    const fetch = ((_input: string, init?: RequestInit) => {
      inits.push(init ?? {});

      return Promise.reject(new TypeError('fetch failed'));
    }) as typeof globalThis.fetch;

    await internetReachable({ urls, fetch, signal: signal() });

    expect(inits).toHaveLength(urls.length);

    for (const init of inits) {
      expect(Object.keys(init).toSorted()).toEqual(['method', 'redirect', 'signal']);
      expect(init).toMatchObject({ method: 'HEAD', redirect: 'manual' });
    }
  });

  it('stops the addresses still waiting once one has answered', async () => {
    const stopped: boolean[] = [];
    const fetch = ((input: string, init?: RequestInit) => {
      if (input === urls[0]) return Promise.resolve(new Response(null, { status: 204 }));

      return new Promise<Response>((_, reject) => {
        init?.signal?.addEventListener('abort', () => {
          stopped.push(true);
          reject(new DOMException('stopped', 'AbortError'));
        });
      });
    }) as typeof globalThis.fetch;

    await expect(internetReachable({ urls, fetch, signal: signal() })).resolves.toBe(true);
    expect(stopped).toEqual([true]);
  });

  it('rejects with the signal’s reason when interrupted, not "offline"', async () => {
    const controller = new AbortController();
    const { fetch } = answering({});

    controller.abort(new Error('stop'));

    await expect(internetReachable({ urls, fetch, signal: controller.signal })).rejects.toThrow(
      'stop',
    );
  });
});

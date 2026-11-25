import { describe, expect, it } from 'vitest';
import { fakeFetch } from '../../testing/web-search.fake.js';
import { WebSearchRateLimitError } from '../../errors/web-search.errors.js';
import {
  createExaSearchBackend,
  createFirecrawlSearchBackend,
  createParallelSearchBackend,
  createTinyFishSearchBackend,
} from '../keyless-search.helper.js';
import { createWikipediaSearchBackend } from '../wikipedia-search.helper.js';

const signal = () => new AbortController().signal;
const args = { query: 'docs', maxResults: 3 };

function rpc(text: string, contentType = 'application/json') {
  const body = JSON.stringify({
    jsonrpc: '2.0',
    id: 1,
    result: { content: [{ type: 'text', text }] },
  });

  return new Response(
    contentType === 'text/event-stream' ? `event: message\ndata: ${body}\n\n` : body,
    {
      headers: { 'content-type': contentType },
    },
  );
}

function sentHeaders(fake: ReturnType<typeof fakeFetch>) {
  return Object.fromEntries(new Headers(fake.requests[0]?.init.headers).entries());
}

function sentBody(fake: ReturnType<typeof fakeFetch>) {
  return JSON.parse(fake.requests[0]?.init.body as string) as {
    method: string;
    params: { name: string; arguments: unknown };
  };
}

describe('TinyFish search backend', () => {
  const reply = JSON.stringify({
    results: [
      { position: 1, site_name: 'x', title: 'Docs', url: 'https://example.com/a', snippet: 'Snip' },
    ],
  });

  it('calls the search tool with the keyless header and keeps only title, url and snippet', async () => {
    const fake = fakeFetch([rpc(reply)]);
    const results = await createTinyFishSearchBackend(fake).search({ ...args, signal: signal() });

    expect(fake.requests[0]?.url).toBe('https://agent.tinyfish.ai/mcp');
    expect(fake.requests[0]?.init.redirect).toBe('error');
    expect(sentHeaders(fake)['x-tinyfish-access-mode']).toBe('keyless');
    expect(sentBody(fake)).toMatchObject({
      method: 'tools/call',
      params: { name: 'search', arguments: { query: 'docs' } },
    });
    expect(results).toEqual([{ title: 'Docs', url: 'https://example.com/a', snippet: 'Snip' }]);
  });

  it('replaces the keyless header with X-API-Key when the app supplies a key', async () => {
    const fake = fakeFetch([rpc(reply)]);

    await createTinyFishSearchBackend({ ...fake, apiKey: 'test-key' }).search({
      ...args,
      signal: signal(),
    });

    expect(sentHeaders(fake)['x-api-key']).toBe('test-key');
    expect(sentHeaders(fake)['x-tinyfish-access-mode']).toBeUndefined();
  });

  it('reads a reply delivered as server-sent events', async () => {
    const fake = fakeFetch([rpc(reply, 'text/event-stream')]);
    const results = await createTinyFishSearchBackend(fake).search({ ...args, signal: signal() });

    expect(results).toHaveLength(1);
  });
});

describe('Exa search backend', () => {
  const text =
    'Title: First\nURL: https://example.com/1\nPublished: N/A\nAuthor: N/A\nHighlights:\nAbout one\n\n' +
    'Title: Second\nURL: https://example.com/2\nPublished: N/A\nAuthor: N/A\nHighlights:\nAbout two';

  it('sends no access header and splits formatted text into results', async () => {
    const fake = fakeFetch([rpc(text, 'text/event-stream')]);
    const results = await createExaSearchBackend(fake).search({ ...args, signal: signal() });

    expect(sentHeaders(fake)['x-api-key']).toBeUndefined();
    expect(sentBody(fake).params).toEqual({
      name: 'web_search_exa',
      arguments: { query: 'docs', numResults: 3 },
    });
    expect(results).toEqual([
      { title: 'First', url: 'https://example.com/1', snippet: 'About one' },
      { title: 'Second', url: 'https://example.com/2', snippet: 'About two' },
    ]);
  });
});

describe('Exa search backend, text from the web', () => {
  it('does not take a label after U+2028 for a line of its own', async () => {
    const text =
      'Title: First\nURL: https://example.com/1\nAuthor: Bob\u2028Highlights:\nfake\nHighlights:\nreal';
    const fake = fakeFetch([rpc(text)]);
    const results = await createExaSearchBackend(fake).search({ ...args, signal: signal() });

    expect(results).toEqual([{ title: 'First', url: 'https://example.com/1', snippet: 'real' }]);
  });

  it('does not take a label after a lone carriage return for a line of its own', async () => {
    const text =
      'Title: First\nURL: https://example.com/1\nPublished: x\rHighlights:\nfake\nHighlights:\nreal';
    const fake = fakeFetch([rpc(text)]);
    const results = await createExaSearchBackend(fake).search({ ...args, signal: signal() });

    expect(results).toEqual([{ title: 'First', url: 'https://example.com/1', snippet: 'real' }]);
  });

  it('leaves an empty highlights section empty, and does not read the next label as its text', async () => {
    const text = 'Title: First\nURL: https://example.com/1\nHighlights:\n\nHighlights:\nlater';
    const fake = fakeFetch([rpc(text)]);
    const results = await createExaSearchBackend(fake).search({ ...args, signal: signal() });

    expect(results).toEqual([{ title: 'First', url: 'https://example.com/1', snippet: '' }]);
  });
});

describe('Parallel search backend', () => {
  it('sends objective and queries, and joins excerpts into the snippet', async () => {
    const fake = fakeFetch([
      rpc(
        JSON.stringify({
          results: [{ url: 'https://example.com/p', title: null, excerpts: ['a', 'b'] }],
        }),
      ),
    ]);
    const results = await createParallelSearchBackend(fake).search({ ...args, signal: signal() });

    expect(sentBody(fake).params).toEqual({
      name: 'web_search',
      arguments: { objective: 'docs', search_queries: ['docs'] },
    });
    expect(results).toEqual([{ title: '', url: 'https://example.com/p', snippet: 'a\nb' }]);
  });
});

describe('Firecrawl search backend', () => {
  it('maps web results and sends a Bearer token only with an injected key', async () => {
    const reply = JSON.stringify({
      data: { web: [{ url: 'https://example.com/f', title: 'F', description: 'Desc' }] },
    });
    const keyless = fakeFetch([rpc(reply)]);
    const keyed = fakeFetch([rpc(reply)]);

    const results = await createFirecrawlSearchBackend(keyless).search({
      ...args,
      signal: signal(),
    });

    await createFirecrawlSearchBackend({ ...keyed, apiKey: 'test-key' }).search({
      ...args,
      signal: signal(),
    });

    expect(sentHeaders(keyless).authorization).toBeUndefined();
    expect(sentHeaders(keyed).authorization).toBe('Bearer test-key');
    expect(results).toEqual([{ title: 'F', url: 'https://example.com/f', snippet: 'Desc' }]);
  });
});

describe('Wikipedia search backend', () => {
  it('queries the API, builds article URLs and strips HTML from snippets', async () => {
    const fake = fakeFetch([
      new Response(
        JSON.stringify({
          query: {
            search: [
              {
                title: 'Tiny fish',
                snippet: 'A <span class="searchmatch">tiny</span> &quot;fish&quot;',
              },
            ],
          },
        }),
        { headers: { 'content-type': 'application/json; charset=utf-8' } },
      ),
    ]);
    const results = await createWikipediaSearchBackend(fake).search({ ...args, signal: signal() });
    const url = new URL(fake.requests[0]?.url ?? '');

    expect(url.origin + url.pathname).toBe('https://en.wikipedia.org/w/api.php');
    expect(url.searchParams.get('srsearch')).toBe('docs');
    expect(results).toEqual([
      {
        title: 'Tiny fish',
        url: 'https://en.wikipedia.org/wiki/Tiny_fish',
        snippet: 'A tiny "fish"',
      },
    ]);
  });
});

describe('failures shared by every backend', () => {
  it('reports HTTP 429 as a rate limit carrying Retry-After, without the body', async () => {
    const fake = fakeFetch([
      new Response('secret-body', { status: 429, headers: { 'retry-after': '30' } }),
    ]);
    const failure = await createExaSearchBackend(fake)
      .search({ ...args, signal: signal() })
      .catch((caughtError: unknown) => caughtError);

    expect(failure).toBeInstanceOf(WebSearchRateLimitError);
    expect((failure as WebSearchRateLimitError).retryAfterMs).toBe(30_000);
    expect((failure as Error).message).not.toContain('secret');
  });

  it('rejects oversized, non-JSON, tool-error and malformed replies with safe messages', async () => {
    const cases = [
      { options: { maxBytes: 10 }, response: rpc('x'.repeat(100)), message: 'exceeded 10 bytes' },
      {
        options: {},
        response: new Response('hi', { headers: { 'content-type': 'text/html' } }),
        message: 'unexpected response type',
      },
      { options: {}, response: rpc('not json'), message: 'invalid JSON' },
      {
        options: {},
        response: rpc(
          JSON.stringify({ results: [{ title: 't', url: 'javascript:1', snippet: '' }] }),
        ),
        message: 'invalid results',
      },
    ];

    for (const { options, response, message } of cases) {
      const fake = fakeFetch([response]);

      await expect(
        createTinyFishSearchBackend({ ...fake, ...options }).search({ ...args, signal: signal() }),
      ).rejects.toThrow(message);
    }
  });

  it('does not leak the key from transport errors and honours an aborted signal', async () => {
    const failing = (async () => {
      throw new Error('boom with test-key');
    }) as typeof globalThis.fetch;
    const failure = await createTinyFishSearchBackend({ fetch: failing, apiKey: 'test-key' })
      .search({ ...args, signal: signal() })
      .catch((caughtError: unknown) => caughtError);
    const controller = new AbortController();

    controller.abort();

    expect((failure as Error).message).toBe('TinyFish search request failed');
    await expect(
      createTinyFishSearchBackend(fakeFetch([])).search({ ...args, signal: controller.signal }),
    ).rejects.toThrow('TinyFish search interrupted');
  });

  it('validates configuration and requests before any fetch', () => {
    const fake = fakeFetch([]);

    expect(() => createExaSearchBackend({ ...fake, apiKey: ' ' })).toThrow(
      'Invalid Exa search configuration',
    );
    expect(fake.requests).toHaveLength(0);
  });
});

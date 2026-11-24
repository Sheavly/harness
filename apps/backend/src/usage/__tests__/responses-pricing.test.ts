import { describe, expect, it } from 'vitest';
import { modelSchema } from '@sheavly/protocol/model/model.validator';
import { collect, fakeFetch } from '@sheavly/testing/fetch/fake-fetch.fake';
import { createResponsesProvider } from '@sheavly/providers/responses/responses.helper';
import { pricedProvider } from '../priced-provider.helper.js';

const model = modelSchema.parse({
  id: '00000000-0000-4000-8000-000000000010',
  name: 'Sol',
  adapter: 'openai',
  definition: {},
  pricing: { input: 2, output: 8, cacheRead: 0.2, cacheWrite: 2.5 },
});

/** The cost and tokens the backend reports for one Responses reply carrying this usage. */
async function priceOf(inputTokensDetails: Record<string, number>) {
  const { fetch } = fakeFetch([
    {
      type: 'response.completed',
      response: {
        usage: {
          input_tokens: 1_000_000,
          output_tokens: 100_000,
          input_tokens_details: inputTokensDetails,
        },
      },
    },
  ]);
  const provider = pricedProvider({
    model,
    provider: createResponsesProvider({
      endpoint: { baseUrl: 'https://example.test/v1', model: 'm', headers: {} },
      request: {
        responseTimeoutMs: 5000,
        retries: 0,
        retryDelayMs: 0,
        offlineTimeoutMs: 0,
        probeUrls: [],
      },
      fetch,
    }),
  });
  const events = await collect(
    provider.stream({ messages: [], tools: [], signal: new AbortController().signal }),
  );

  return events.at(-1);
}

describe('Responses usage through backend pricing', () => {
  it('charges ordinary input, cache reads and cache writes once each at their rates', async () => {
    // 400k ordinary * 2 + 500k read * 0.2 + 100k written * 2.5 + 100k output * 8 = 1.95
    expect(await priceOf({ cached_tokens: 500_000, cache_write_tokens: 100_000 })).toMatchObject({
      usage: {
        tokens: { cacheReadTokens: 500_000, cacheWriteTokens: 100_000 },
        estimatedCostUsd: 1.95,
      },
    });
  });

  it('rejects inconsistent upstream totals before calculating a negative input cost', async () => {
    await expect(priceOf({ cached_tokens: 1_000_000, cache_write_tokens: 1 })).rejects.toThrow(
      'Responses stream ended before response.completed',
    );
  });

  it('prices a legacy reply without cache_write_tokens with no writes', async () => {
    // 500k ordinary * 2 + 500k read * 0.2 + 100k output * 8 = 1.9
    expect(await priceOf({ cached_tokens: 500_000 })).toMatchObject({
      usage: { tokens: { cacheWriteTokens: 0 }, estimatedCostUsd: 1.9 },
    });
  });
});

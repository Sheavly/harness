import { describe, expect, it } from 'vitest';
import { ModelFetchError } from '../../errors/providers.errors.js';
import { TEST_REQUEST } from '../../testing/request.constants.js';
import { sendCollecting } from '../../testing/send.fake.js';

describe('sendRequest and the model fetch', () => {
  it('passes a request the model fetch refuses through as it came, and never retries it', async () => {
    let calls = 0;
    const refusing = (async () => {
      calls += 1;
      throw new ModelFetchError({ reason: 'form_data_body', message: 'no FormData' });
    }) as typeof globalThis.fetch;

    const sent = sendCollecting({
      api: 'Test API',
      fetch: refusing,
      url: new URL('https://model.test/v1/messages'),
      init: { method: 'POST', body: '{}' },
      policy: { ...TEST_REQUEST, retries: 2 },
      signal: new AbortController().signal,
    });

    await expect(sent).rejects.toBeInstanceOf(ModelFetchError);
    expect(calls).toBe(1);
  });
});

import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { promptEntries } from '@sheavly/client/prompt/prompt.helper';
import { modelIdSchema } from '@sheavly/protocol/model/model.validator';
import { profileIdSchema } from '@sheavly/protocol/profile/profile.validator';
import { fakeFetch } from '@sheavly/testing/fetch/fake-fetch.fake';
import { testBackend } from '../../testing/backend.fake.js';

// A reopened conversation keeps the cost recorded when each call was made, and prices only the calls
// after it by the model's price as configured then.

let root = '';

afterEach(async () => {
  if (root) await rm(root, { recursive: true, force: true });
});

describe('what a reopened conversation used, priced', () => {
  it('keeps recorded cost across a reopen and prices only new calls by the newly configured price', async () => {
    root = await mkdtemp(path.join(tmpdir(), 'usage-backend-'));
    const workspace = path.join(root, 'workspace');

    await mkdir(workspace);
    const { fetch } = fakeFetch([
      {
        type: 'response.completed',
        response: {
          usage: {
            input_tokens: 100,
            output_tokens: 20,
            input_tokens_details: { cached_tokens: 50 },
          },
        },
      },
    ]);
    const backend = testBackend({ home: path.join(root, 'home'), workspace, fetch });
    const { client } = backend;
    const profile = profileIdSchema.parse('00000000-0000-4000-8000-000000000001');
    const model = modelIdSchema.parse('00000000-0000-4000-8000-000000000002');
    const definition = { name: 'Priced', adapter: 'openai', definition: { model: 'test' } };

    try {
      await client.send('putProfile', { profile, body: { name: 'Work' } });
      await client.send('putModel', {
        profile,
        model,
        body: { ...definition, pricing: { input: 2, output: 8, cacheRead: 0.2, cacheWrite: 2.5 } },
      });
      await client.send('putCredential', { profile, model, body: { secrets: { apiKey: 'fake' } } });
      await client.send('setDefaultProfile', { body: { profile } });
      const { id } = await client.call('startConversation', { body: {} });

      for (const text of ['first', 'second']) {
        for await (const _entry of promptEntries({ client, id, prompt: { text } })) {
          // Drain the stream so its final usage has been recorded.
        }
      }

      expect((await client.call('getUsage', { id })).total).toMatchObject({
        calls: 2,
        inputTokens: 200,
        outputTokens: 40,
        cacheReadTokens: 100,
        estimatedCostUsd: 0.00054,
        unpricedCalls: 0,
        missingUsageCalls: 0,
      });
      await client.send('closeConversation', { id });
      await client.send('putModel', {
        profile,
        model,
        body: {
          ...definition,
          contextWindow: 1_000_000,
          pricing: { input: 4, output: 16, cacheRead: 0.4, cacheWrite: 5 },
        },
      });
      await client.call('reopenConversation', { id });
      expect((await client.call('getUsage', { id })).total.estimatedCostUsd).toBeCloseTo(0.00054);

      for await (const _entry of promptEntries({ client, id, prompt: { text: 'third' } })) {
        // The new call is priced with the provider built on reopen, not the earlier call's rates.
      }

      const { total } = await client.call('getUsage', { id });

      expect(total.calls).toBe(3);
      expect(total.estimatedCostUsd).toBeCloseTo(0.00108);
    } finally {
      await backend.conversations.closeAll();
    }
  });
});

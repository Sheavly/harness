import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { defineAdapter } from '@sheavly/core/adapter/adapter.utils';
import type { Provider } from '@sheavly/core/provider/provider.types';
import { MODEL_FETCH_HELLO } from '../../testing/client-hello.constants.js';
import { captureClientHello, helloShape } from '../../testing/client-hello.fake.js';
import { createDefaultRegistry } from '../default-registry.helper.js';
import { AdapterRegistry } from '../registry.service.js';

describe('AdapterRegistry', () => {
  it("validates config with the adapter's zod schema", () => {
    const registry = new AdapterRegistry().register(stubAdapter);

    expect(() => registry.create('stub', {})).toThrow('Invalid config for stub');
  });

  it('rejects unknown kinds and lists what is available', () => {
    expect(() => new AdapterRegistry().register(stubAdapter).create('nope', {})).toThrow(
      'Unknown adapter: nope (available: stub)',
    );
  });

  it('rejects duplicate registrations', () => {
    expect(() => new AdapterRegistry().register(stubAdapter).register(stubAdapter)).toThrow(
      'Adapter already registered: stub',
    );
  });

  it('accepts new adapters without touching built-in code', () => {
    const registry = new AdapterRegistry().register(stubAdapter);

    expect(registry.kinds()).toEqual(['stub']);
    expect(registry.create('stub', { reply: 'x' })).toBeDefined();
  });
});

describe('createDefaultRegistry', () => {
  it('has the built-in adapters, and no default model of its own', () => {
    const registry = createDefaultRegistry();

    expect(registry.kinds()).toEqual([
      'openai',
      'azure-openai',
      'azure-chat',
      'azure-anthropic',
      'bedrock-anthropic',
      'bedrock-openai',
    ]);
    expect(() => registry.create('openai', { apiKey: 'k' })).toThrow('Invalid config for openai');
  });

  it("sends model calls with the model fetch by default, so a ClientHello isn't split", async () => {
    const capture = await captureClientHello();

    try {
      const checked = await createDefaultRegistry().check({
        kind: 'azure-anthropic',
        config: { apiKey: 'k', baseUrl: `${capture.url}/anthropic`, deployment: 'claude' },
      });

      expect(helloShape(await capture.hello)).toEqual(MODEL_FETCH_HELLO);
      expect(checked.status).toBe('unreachable');
    } finally {
      await capture.close();
    }
  });
});

/** Test-only adapter showing the extension point. */
const stubAdapter = defineAdapter({
  kind: 'stub',
  description: 'Replies with fixed text',
  configSchema: z.object({ reply: z.string() }),
  create: ({ config: { reply } }): Provider => ({
    async *stream() {
      yield { type: 'text_delta', text: reply };
      yield { type: 'done', stopReason: 'end_turn' };
    },
  }),
});

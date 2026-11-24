import { describe, expect, it } from 'vitest';
import { createDefaultRegistry } from '@sheavly/providers/registry/default-registry.helper';
import { assertModelHosting, setupModelCatalog } from '../model-catalog.helper.js';

const adapters = createDefaultRegistry().describe();

describe('model-first setup catalogue', () => {
  it('has unique model and hosting choices whose presets validate against their adapters', () => {
    const registry = createDefaultRegistry();
    const models = setupModelCatalog(adapters);

    expect(new Set(models.map(({ identity }) => identity.model)).size).toBe(models.length);

    for (const model of models) {
      expect(new Set(model.hosts.map(({ adapter }) => adapter)).size).toBe(model.hosts.length);

      for (const host of model.hosts) {
        // What a person types in setup: the endpoint, or a Bedrock Region, profile and output limit.
        const owner = host.adapter === 'bedrock-openai' ? 'openai' : 'anthropic';
        const typed = {
          baseUrl: 'https://example.test',
          auth: 'api-key',
          region: 'us-east-1',
          maxTokens: 1024,
          model: `us.${owner}.some-model`,
        };

        expect(
          registry.validateDefinition({
            kind: host.adapter,
            definition: { ...typed, ...host.defaults, ...host.fixed },
            host: {
              request: {
                responseTimeoutMs: 1000,
                retries: 0,
                retryDelayMs: 0,
                offlineTimeoutMs: 0,
                probeUrls: [],
              },
            },
          }),
        ).toEqual([]);
      }
    }
  });
  it('advertises only implemented compatible routes and supplies model-specific settings', () => {
    const models = setupModelCatalog(adapters);
    const hosts = (model: string) => models.find((entry) => entry.identity.model === model)?.hosts;

    expect(hosts('gpt-6.1-sol')?.map(({ name }) => name)).toEqual([
      'Azure',
      'OpenAI',
      'AWS Bedrock',
    ]);
    expect(hosts('claude-opus-5-5')?.map(({ adapter }) => adapter)).toEqual([
      'azure-anthropic',
      'bedrock-anthropic',
    ]);
    expect(hosts('deepseek-v4-flash')).toEqual([
      {
        adapter: 'azure-chat',
        name: 'Azure',
        defaults: { deployment: 'deepseek-v4-flash', replayReasoning: true },
        fixed: {},
      },
    ]);
    expect(models.find(({ identity }) => identity.model === 'DeepSeek-V4.1-Flash-1017')).toEqual({
      name: 'DeepSeek V4.1 Flash (1017)',
      identity: { model: 'DeepSeek-V4.1-Flash-1017', family: 'deepseek' },
      hosts: [
        {
          adapter: 'azure-chat',
          name: 'Azure',
          defaults: {
            deployment: 'DeepSeek-V4.1-Flash-1017',
            replayReasoning: true,
            thinkingMode: 'enabled',
            effortProfile: 'deepseek',
          },
          fixed: {},
        },
      ],
    });
    expect(hosts('gpt-6.1-sol')?.find(({ adapter }) => adapter === 'openai')?.fixed).toEqual({
      model: 'gpt-6.1-sol',
    });
  });

  it('omits models without an available host and returns fresh identity objects', () => {
    expect(setupModelCatalog([])).toEqual([]);
    const nativeOnly = adapters.filter(({ kind }) => kind === 'openai');
    const models = setupModelCatalog(nativeOnly);

    expect(models).toHaveLength(3);
    expect(models.every(({ identity }) => identity.family === 'gpt')).toBe(true);
    models[0]!.identity.model = 'changed';
    expect(setupModelCatalog(nativeOnly)[0]?.identity.model).toBe('gpt-6.1-sol');
  });

  it('rejects incompatible hosts, false families and mismatched native IDs', () => {
    const model = {
      name: 'Opus',
      adapter: 'openai',
      definition: { model: 'claude-opus-5-5' },
      identity: { model: 'claude-opus-5-5', family: 'claude' },
    };

    expect(() => assertModelHosting({ model, adapters })).toThrow('does not support');
    expect(() =>
      assertModelHosting({
        model: { ...model, identity: { ...model.identity, family: 'gpt' } },
        adapters,
      }),
    ).toThrow('family');
    expect(() =>
      assertModelHosting({
        model: { ...model, identity: { model: 'gpt-6.1-sol', family: 'gpt' } },
        adapters,
      }),
    ).toThrow('Use gpt-6.1-sol');
  });

  it.each(['DeepSeek-V4.1-Flash-1017', 'production-east'])(
    'accepts snapshot deployment %s only on azure-chat',
    (deployment) => {
      const model = {
        name: 'Snapshot',
        adapter: 'azure-chat',
        identity: { model: 'DeepSeek-V4.1-Flash-1017', family: 'deepseek' },
        definition: { deployment },
      };

      expect(() => assertModelHosting({ adapters, model })).not.toThrow();

      for (const adapter of ['azure-openai', 'openai', 'azure-anthropic']) {
        expect(() => assertModelHosting({ adapters, model: { ...model, adapter } })).toThrow(
          'does not support',
        );
      }

      expect(() =>
        assertModelHosting({
          adapters: adapters.filter(({ kind }) => kind !== 'azure-chat'),
          model,
        }),
      ).toThrow('does not support');
    },
  );

  it('does not let a lowercase identity escape the catalogue host check', () => {
    const model = {
      name: 'Snapshot',
      adapter: 'azure-openai',
      identity: { model: 'deepseek-v4.1-flash-1017', family: 'deepseek' },
      definition: { deployment: 'DeepSeek-V4.1-Flash-1017' },
    };

    expect(() => assertModelHosting({ adapters, model })).toThrow('does not support');
  });

  it('accepts custom deployments for known models and leaves models without an identity supported', () => {
    expect(() =>
      assertModelHosting({
        adapters,
        model: {
          name: 'Production',
          adapter: 'azure-openai',
          definition: { deployment: 'production' },
          identity: { model: 'gpt-6.1-sol', family: 'gpt' },
        },
      }),
    ).not.toThrow();
    expect(() =>
      assertModelHosting({
        adapters,
        model: { name: 'No identity', adapter: 'openai', definition: { model: 'plain' } },
      }),
    ).not.toThrow();
    expect(() =>
      assertModelHosting({
        adapters,
        model: {
          name: 'Custom',
          adapter: 'openai',
          definition: { model: 'custom' },
          identity: { model: 'custom' },
        },
      }),
    ).not.toThrow();
  });
});

import { describe, expect, it } from 'vitest';
import { createDefaultRegistry } from '../default-registry.helper.js';

const registry = createDefaultRegistry();
const HOST = {
  request: {
    responseTimeoutMs: 60_000,
    retries: 2,
    retryDelayMs: 1000,
    offlineTimeoutMs: 3_600_000,
    probeUrls: ['https://probe.test'],
  },
};
const azure = {
  baseUrl: 'https://acme.openai.azure.com/openai/v1',
  deployment: 'gpt-5',
};
const fieldsOf = (problems: { field: string }[]) => problems.map((problem) => problem.field);

describe('AdapterRegistry.validateDefinition', () => {
  it('accepts a definition that is complete without its key', () => {
    expect(
      registry.validateDefinition({ kind: 'azure-openai', definition: azure, host: HOST }),
    ).toEqual([]);
    expect(
      registry.validateDefinition({ kind: 'openai', definition: { model: 'gpt-6' }, host: HOST }),
    ).toEqual([]);
  });

  it('names a missing field, and one that is wrong, but never the missing key', () => {
    const problems = registry.validateDefinition({
      kind: 'azure-openai',
      definition: { baseUrl: 'not a url' },
      host: HOST,
    });

    expect(fieldsOf(problems)).toEqual(expect.arrayContaining(['baseUrl', 'deployment']));
    expect(fieldsOf(problems)).not.toContain('apiKey');
  });

  it('applies the adapter’s own rules to the definition', () => {
    const claude = {
      baseUrl: 'https://acme.services.ai.azure.com/anthropic',
      deployment: 'claude',
      maxTokens: 1000,
    };

    expect(
      registry.validateDefinition({ kind: 'azure-anthropic', definition: claude, host: HOST }),
    ).toEqual([]);
    expect(
      fieldsOf(
        registry.validateDefinition({
          kind: 'azure-anthropic',
          definition: { ...claude, thinkingBudget: 5000 },
          host: HOST,
        }),
      ),
    ).toEqual(['thinkingBudget']);
    expect(
      fieldsOf(
        registry.validateDefinition({
          kind: 'azure-anthropic',
          definition: { ...claude, thinkingBudget: 100 },
          host: HOST,
        }),
      ),
    ).toContain('thinkingBudget');
  });

  it('refuses a key in the definition: a model’s file holds none', () => {
    const problems = registry.validateDefinition({
      kind: 'azure-openai',
      definition: { ...azure, apiKey: 'sk-real-key' },
      host: HOST,
    });

    expect(problems).toEqual([
      { field: 'apiKey', message: expect.stringContaining('holds no secret') as string },
    ]);
    // The message names the field, not the key.
    expect(JSON.stringify(problems)).not.toContain('sk-real-key');
  });

  it('does not let a definition override what the host supplies', () => {
    const problems = registry.validateDefinition({
      kind: 'azure-openai',
      definition: { ...azure, request: { responseTimeoutMs: -1 } },
      host: HOST,
    });

    expect(problems).toEqual([]);
  });

  describe('for a model that signs in one of two ways', () => {
    const bedrock = { auth: 'access-key', region: 'us-east-1', model: 'us.openai.gpt-6-astra' };

    // Every secret is stood in for, so the rule that a model signs in one way only is judged
    // there too, and its issues sit on the secrets' own paths, which are not reported: a setup that
    // has no key yet is complete. A problem with a setting must still be.
    it('is complete without its secrets, whichever way it signs in', () => {
      for (const auth of ['access-key', 'api-key']) {
        expect(
          registry.validateDefinition({
            kind: 'bedrock-openai',
            definition: { ...bedrock, auth },
            host: HOST,
          }),
          auth,
        ).toEqual([]);
      }
    });

    it('still names a wrong setting, and a way of signing in that is not one', () => {
      const problems = registry.validateDefinition({
        kind: 'bedrock-openai',
        definition: { auth: 'password', region: 'evil.example.com/', model: 'gpt-6-astra' },
        host: HOST,
      });

      expect(fieldsOf(problems)).toEqual(expect.arrayContaining(['auth', 'region', 'model']));
    });

    it('refuses any of its secrets in the definition', () => {
      const problems = registry.validateDefinition({
        kind: 'bedrock-openai',
        definition: { ...bedrock, accessKeyId: 'AKIDLEAK', sessionToken: 'tokenleak' },
        host: HOST,
      });

      expect(fieldsOf(problems).sort()).toEqual(['accessKeyId', 'sessionToken']);
      expect(JSON.stringify(problems)).not.toContain('LEAK');
      expect(JSON.stringify(problems)).not.toContain('tokenleak');
    });
  });

  it('refuses an adapter it does not have', () => {
    expect(() => registry.validateDefinition({ kind: 'nope', definition: {}, host: HOST })).toThrow(
      'Unknown adapter: nope',
    );
  });
});

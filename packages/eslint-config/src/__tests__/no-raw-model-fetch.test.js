import { describe, expect, it } from 'vitest';
import { harnessPlugin } from '../plugin.js';
import { ruleIsErrorOn } from '../testing/coding-rule.fake.js';
import { typescriptRuleTester } from '../testing/rule-tester.fake.js';

const ruleTester = typescriptRuleTester({ sourceType: 'module', ecmaVersion: 'latest' });
const ERROR = [{ messageId: 'm0' }];

ruleTester.run('no-raw-model-fetch', harnessPlugin.rules['no-raw-model-fetch'], {
  valid: [
    'createDefaultRegistry({ fetch: createModelFetch() });',
    'createDefaultRegistry({ fetch: createModelFetch(), onReplayDropped });',
    'createDefaultRegistry();',
    'new AdapterRegistry();',
    'new AdapterRegistry({ fetch: createModelFetch() });',
    "providers.createDefaultRegistry({ 'fetch': createModelFetch() });",
    // Only an adapter registry's deps: another API's own `fetch` option is not a model call.
    'createClient({ url, token, fetch: globalThis.fetch });',
    'searchWith({ fetch });',
  ],
  invalid: [
    { code: 'createDefaultRegistry({ fetch: globalThis.fetch });', errors: ERROR },
    { code: 'createDefaultRegistry({ fetch, onReplayDropped });', errors: ERROR },
    { code: 'createDefaultRegistry({ fetch: fetch });', errors: ERROR },
    { code: 'new AdapterRegistry({ fetch: globalThis.fetch });', errors: ERROR },
    { code: 'new AdapterRegistry({ fetch: makeFetch() });', errors: ERROR },
    { code: "createDefaultRegistry({ 'fetch': globalThis.fetch });", errors: ERROR },
    { code: 'providers.createDefaultRegistry({ fetch });', errors: ERROR },
    { code: 'new registry.AdapterRegistry({ fetch: globalThis.fetch });', errors: ERROR },
    {
      code: "import { fetch as undiciFetch } from 'undici'; createDefaultRegistry({ fetch: undiciFetch });",
      errors: ERROR,
    },
  ],
});

const on = (params) => ruleIsErrorOn({ rule: 'harness/no-raw-model-fetch', ...params });

describe('no-raw-model-fetch', () => {
  it('is on where the backend and the providers build a registry', async () => {
    expect(await on({ folder: 'apps/backend', file: 'src/profiles/profiles.service.ts' })).toBe(
      true,
    );
    expect(
      await on({ folder: 'packages/providers', file: 'src/registry/default-registry.helper.ts' }),
    ).toBe(true);
  });

  it('is off in tests and fakes, which pass a fake fetch', async () => {
    expect(await on({ folder: 'apps/backend', file: 'src/testing/backend.fake.ts' })).toBe(false);
    expect(
      await on({ folder: 'packages/providers', file: 'src/registry/__tests__/check.test.ts' }),
    ).toBe(false);
  });
});

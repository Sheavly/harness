import { describe, expect, it } from 'vitest';
import { typescriptRuleTester } from '../testing/rule-tester.fake.js';
import { ruleIsErrorOn } from '../testing/coding-rule.fake.js';
import { harnessPlugin } from '../plugin.js';

const RULE_NAME = 'no-handrolled-model-send';
const sendTester = typescriptRuleTester({ ecmaVersion: 'latest', sourceType: 'module' });

sendTester.run(RULE_NAME, harnessPlugin.rules[RULE_NAME], {
  valid: [
    'const response = yield* sendRequest({ api, fetch: config.fetch, url, init, policy, signal });',
    'const sender = { fetch: config.fetch };',
    'const reply = await client.send(request);',
    'const url = new URL(path);',
  ],
  invalid: [
    { code: 'const response = await config.fetch(url, init);', errors: [{ messageId: 'm0' }] },
    { code: 'const response = await deps.fetch(url, init);', errors: [{ messageId: 'm0' }] },
    {
      code: 'const response = await this.options.fetch(url, init);',
      errors: [{ messageId: 'm0' }],
    },
    {
      code: 'const { fetch } = config; const response = await fetch(url, init);',
      errors: [{ messageId: 'm0' }],
    },
    { code: "const response = await deps['fetch'](url, init);", errors: [{ messageId: 'm0' }] },
    {
      code: 'const response = await deps.fetch.call(deps, url, init);',
      errors: [{ messageId: 'm0' }],
    },
    {
      code: 'const response = await fetch.apply(undefined, [url, init]);',
      errors: [{ messageId: 'm0' }],
    },
    { code: 'const send = deps.fetch.bind(deps); void send;', errors: [{ messageId: 'm0' }] },
  ],
});

const PROVIDERS = 'packages/providers';
const on = (file) => ruleIsErrorOn({ rule: `harness/${RULE_NAME}`, folder: PROVIDERS, file });

// The two exceptions are pinned: a renamed helper or a widened override changes these answers.
describe('no-handrolled-model-send in providers', () => {
  it('is on for every protocol and adapter, so each sends through sendRequest', async () => {
    for (const file of [
      'src/responses/responses.helper.ts',
      'src/chat-completions/chat-completions.helper.ts',
      'src/anthropic-messages/messages.helper.ts',
      'src/azure/chat.adapter.ts',
      'src/http/outage.helper.ts',
    ]) {
      expect(await on(file), file).toBe(true);
    }
  });

  it('is off only where the injected fetch is called: sendRequest and the connectivity probe', async () => {
    for (const file of ['src/http/request.helper.ts', 'src/http/connectivity.helper.ts']) {
      expect(await on(file), file).toBe(false);
    }
  });

  it('is off in tests and fakes, which call a fake fetch directly', async () => {
    for (const file of ['src/http/__tests__/x.test.ts', 'src/testing/x.fake.ts']) {
      expect(await on(file), file).toBe(false);
    }
  });
});

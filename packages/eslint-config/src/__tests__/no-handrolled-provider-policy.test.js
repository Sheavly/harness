import { describe, expect, it } from 'vitest';
import { typescriptRuleTester } from '../testing/rule-tester.fake.js';
import { ruleIsErrorOn } from '../testing/coding-rule.fake.js';
import { harnessPlugin } from '../plugin.js';

const POLICY_RULE = 'no-handrolled-provider-policy';
const policyTester = typescriptRuleTester({ ecmaVersion: 'latest', sourceType: 'module' });

policyTester.run(POLICY_RULE, harnessPlugin.rules[POLICY_RULE], {
  valid: [
    'const items = ownReplay({ items: message.reasoning, source, onDropped });',
    'const wait = retryAfterMs(response.headers.get("x-request-id"));',
    'if (item.kind === "reasoning") keep(item);',
    'const reader = stream.pipeThrough(decoder);',
  ],
  invalid: [
    { code: 'const reader = response.body.getReader();', errors: [{ messageId: 'm0' }] },
    { code: "const wait = response.headers.get('retry-after');", errors: [{ messageId: 'm1' }] },
    { code: "const wait = response.headers.get('Retry-After');", errors: [{ messageId: 'm1' }] },
    {
      code: 'const mine = items.filter((item) => item.source === source);',
      errors: [{ messageId: 'm2' }],
    },
    { code: 'if (item.source !== source) drop(item);', errors: [{ messageId: 'm2' }] },
    { code: 'if (source === item.source) keep(item);', errors: [{ messageId: 'm2' }] },
  ],
});

const PROVIDERS = 'packages/providers';
const on = (file) => ruleIsErrorOn({ rule: `harness/${POLICY_RULE}`, folder: PROVIDERS, file });

// The two exceptions are pinned: a renamed helper or a widened override changes these answers.
describe('no-handrolled-provider-policy in providers', () => {
  it('is on for every protocol and adapter', async () => {
    for (const file of [
      'src/responses/input.utils.ts',
      'src/chat-completions/input.utils.ts',
      'src/anthropic-messages/input.utils.ts',
      'src/azure/chat.adapter.ts',
    ]) {
      expect(await on(file), file).toBe(true);
    }
  });

  it('is off only where each decision is made: the retry policy, the replay check and the body reader', async () => {
    for (const file of [
      'src/http/retry-policy.helper.ts',
      'src/http/replay.utils.ts',
      'src/http/stream-chunks.helper.ts',
    ]) {
      expect(await on(file), file).toBe(false);
    }
  });

  it('is on in the request helper, which only uses the policy', async () => {
    expect(await on('src/http/request.helper.ts')).toBe(true);
  });

  it('is off in tests and fakes, which assert on headers and sources', async () => {
    for (const file of ['src/http/__tests__/x.test.ts', 'src/testing/x.fake.ts']) {
      expect(await on(file), file).toBe(false);
    }
  });
});

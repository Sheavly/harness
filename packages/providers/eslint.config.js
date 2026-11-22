import { baseConfig, modelFetchConfinement } from '@sheavly/eslint-config';

export default [
  ...baseConfig({ tsconfigRootDir: import.meta.dirname }),
  // A model call goes through the injected `deps.fetch`, never Node's global `fetch`.
  modelFetchConfinement,
  {
    // The shared decisions of every protocol: a protocol reads a body, a retry-after header and a
    // reasoning item's source only through the helpers that own them (see the rule's comment).
    files: ['src/**/*.ts'],
    ignores: ['src/**/__tests__/**', 'src/testing/**'],
    rules: { 'harness/no-handrolled-provider-policy': 'error' },
  },
  {
    // The one place each decision is made: the retry policy reads `retry-after`, the replay check
    // compares a reasoning item's `source`. `request.helper.ts` needs no exemption.
    files: ['src/http/retry-policy.helper.ts', 'src/http/replay.utils.ts'],
    rules: { 'harness/no-handrolled-provider-policy': 'off' },
  },
  {
    // The one reader of server-sent events: every protocol's reply goes through `readReply`.
    files: ['src/http/reply-reader.helper.ts'],
    rules: { 'harness/no-handrolled-reply-reader': 'off' },
  },
  {
    // The model fetch itself: it builds undici's pool and probes OpenSSL's groups with `node:tls`.
    files: ['src/http/model-fetch.helper.ts'],
    rules: { 'no-restricted-imports': 'off' },
  },
];

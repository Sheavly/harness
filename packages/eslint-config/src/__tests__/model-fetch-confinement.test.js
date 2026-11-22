import path from 'node:path';
import { ESLint, Linter } from 'eslint';
import { describe, expect, it } from 'vitest';
import { modelFetchConfinement } from '../model-fetch-confinement.js';
import { sourceFilesUnder } from '../testing/source-files.fake.js';

const PROVIDERS = path.resolve(import.meta.dirname, '../../../providers');
const GLOBALS = 'no-restricted-globals';
const PROPERTIES = 'no-restricted-properties';
const IMPORTS = 'no-restricted-imports';
/** The one file that builds the model fetch, and so imports undici and `node:tls`. */
const MODEL_FETCH = 'src/http/model-fetch.helper.ts';
const eslint = new ESLint({ cwd: PROVIDERS });

/** The ids of the rules `code` breaks, linted with `modelFetchConfinement`'s rules. */
function broken(code) {
  const messages = new Linter().verify(
    code,
    [
      {
        files: ['**/*.js'],
        languageOptions: {
          sourceType: 'module',
          ecmaVersion: 'latest',
          // Declared, so `no-restricted-globals` sees it as the global it is.
          globals: { fetch: 'readonly' },
        },
        rules: modelFetchConfinement.rules,
      },
    ],
    'adapter.js',
  );

  return messages.map((message) => message.ruleId);
}

/**
 * Each confinement rule as the providers' real config resolves it for `file`: its options when it
 * is an error, else 'off'. Comparing options, not only the level, catches a later block that
 * replaces them and so drops the fetch ban.
 */
async function resolvedFor(file) {
  const config = await eslint.calculateConfigForFile(path.join(PROVIDERS, file));

  return Object.fromEntries(
    [GLOBALS, PROPERTIES, IMPORTS].map((rule) => {
      const [level, ...options] = config?.rules[rule] ?? [0];

      return [rule, level === 2 ? options : 'off'];
    }),
  );
}

const confined = (rule) => modelFetchConfinement.rules[rule].slice(1);

describe('modelFetchConfinement', () => {
  it.each([
    ['fetch(url);', GLOBALS],
    ['const send = fetch;', GLOBALS],
    ['globalThis.fetch(url);', PROPERTIES],
    ["globalThis['fetch'](url);", PROPERTIES],
    ['const { fetch: send } = globalThis;', PROPERTIES],
    ['global.fetch(url);', PROPERTIES],
    ['self.fetch(url);', PROPERTIES],
    ['window.fetch(url);', PROPERTIES],
    ["import { fetch } from 'undici';", IMPORTS],
    ["import { request } from 'undici';", IMPORTS],
    ["import https from 'node:https';", IMPORTS],
    ["import { connect } from 'tls';", IMPORTS],
  ])('rejects a way round the injected fetch: %s', (code, rule) => {
    expect(broken(code)).toEqual([rule]);
  });

  it.each([
    'function send(fetch) { return fetch(url); }',
    'const { fetch } = deps; fetch(url);',
    'deps.fetch(url);',
    'createDefaultRegistry({ fetch: createModelFetch() });',
    "import { createHash } from 'node:crypto';",
  ])('accepts the injected fetch and what reaches no network: %s', (code) => {
    expect(broken(code)).toEqual([]);
  });

  it('holds, with its own options, for every providers source file but the model fetch’s imports', async () => {
    const sources = sourceFilesUnder({ root: PROVIDERS, folder: 'src' }).filter((file) =>
      file.endsWith('.ts'),
    );

    expect(sources).toContain(MODEL_FETCH);

    for (const file of sources) {
      const imports = file === MODEL_FETCH ? 'off' : confined(IMPORTS);

      expect(await resolvedFor(file), file).toEqual({
        [GLOBALS]: confined(GLOBALS),
        [PROPERTIES]: confined(PROPERTIES),
        [IMPORTS]: imports,
      });
    }
  });

  it('is off for its tests and fakes, which build or stub their own fetch', async () => {
    for (const file of [
      'src/registry/__tests__/check.test.ts',
      'src/testing/client-hello.fake.ts',
    ]) {
      expect(await resolvedFor(file), file).toEqual({
        [GLOBALS]: 'off',
        [PROPERTIES]: 'off',
        [IMPORTS]: 'off',
      });
    }
  });
});

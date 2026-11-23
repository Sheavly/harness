// Shared ESLint config for every @sheavly/harness workspace: strict type-aware TypeScript,
// readability rules that track comprehension cost, the file structure rules, and no inline
// escape hatches. A workspace's `eslint.config.js` is
// `baseConfig({ tsconfigRootDir: import.meta.dirname })`, plus its own layer boundaries and
// exceptions.
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import js from '@eslint/js';
import stylistic from '@stylistic/eslint-plugin';
import prettier from 'eslint-config-prettier';
import reactHooks from 'eslint-plugin-react-hooks';
import sonarjs from 'eslint-plugin-sonarjs';
import unicorn from 'eslint-plugin-unicorn';
import { defineConfig, globalIgnores } from 'eslint/config';
import globals from 'globals';
import tseslint from 'typescript-eslint';
import { DEFAULT_MAX_LINES, FILE_KIND_POLICIES, globsOfKind, TEST_FOLDER } from './file-kinds.js';
import { harnessPlugin } from './plugin.js';
import { READABILITY_RULES } from './readability.js';
import { TYPESCRIPT_RULES } from './typescript.js';

// The confinement of an app's replay command, for that app to spread into its own config.
export { replayConfinement } from './replay-confinement.js';
// The terminal app's rule that the code starting its own backend never reads the discovery file.
export { connectBackendConfinement } from './connect-backend-confinement.js';
// The launcher's rule that systemd's programs are run only behind `SystemTools`, created in cli.ts.
export { systemdConfinement } from './systemd-confinement.js';
// The storage package's rule that stored profiles and indexes are read through the migration.
export { storedFileReads } from './stored-file-reads.js';
// The providers package's rule that a model call goes through the injected fetch, not the global.
export { modelFetchConfinement } from './model-fetch-confinement.js';

const TYPED_FILES = ['**/*.ts', '**/*.tsx'];
const PLAIN_JS_FILES = ['**/*.js', '**/*.mjs'];

const TEST_FILES = [`**/${TEST_FOLDER}/**/*.{ts,tsx}`, 'src/testing/**/*.{ts,tsx}'];

/**
 * Where the conventions and structure rules apply: a workspace's own TypeScript source, `.tsx`
 * (a React view, its kind `component`) included.
 */
const SOURCE_FILES = ['src/**/*.{ts,tsx}'];
/** Files outside any tsconfig (root configs) that still get type info, from a default project. */
const DEFAULT_PROJECT_FILES = ['*.ts', '*.js', '*.mjs'];

/**
 * The files of `tsconfigRootDir` that are test code: its tests and fakes, or all its source when
 * the workspace is test-only (`sheavly.testOnly` in its package.json, like `@sheavly/testing`).
 */
function testFilesOf(tsconfigRootDir) {
  const manifest = path.join(tsconfigRootDir, 'package.json');
  const testOnly =
    existsSync(manifest) && JSON.parse(readFileSync(manifest, 'utf8')).sheavly?.testOnly === true;

  return testOnly ? [...TEST_FILES, ...SOURCE_FILES] : TEST_FILES;
}

function maxLines(max) {
  return max === null ? 'off' : ['error', { max, skipBlankLines: true, skipComments: true }];
}

// Large files are where structure gets lost; split by responsibility before adding more.
// One block per kind, read off FILE_KIND_POLICIES, so a new kind brings its own limit.
const maxLinesPerKind = Object.entries(FILE_KIND_POLICIES).map(([kind, policy]) => ({
  files: globsOfKind(kind),
  rules: { 'max-lines': maxLines(policy.maxLines) },
}));

/**
 * @param {object} params
 * @param {string} params.tsconfigRootDir The workspace directory: pass `import.meta.dirname`.
 * @param {string[]} [params.entryFiles] Files without a kind (an app's entry points).
 *
 * A workspace in `apps/` is a front end and a host: its source may talk to the terminal, print and
 * read env. Every other workspace is a backend that emits typed events, so none of that is allowed
 * there. Read from where the workspace is, so a new app needs no list and a package can't opt in.
 */
export function baseConfig(params) {
  const { tsconfigRootDir, entryFiles = [] } = params;
  const testFiles = testFilesOf(tsconfigRootDir);
  const isApp = path.basename(path.dirname(tsconfigRootDir)) === 'apps';
  const frontEndFiles = isApp ? SOURCE_FILES : [];
  const isExtension = path.basename(path.dirname(tsconfigRootDir)) === 'extensions';

  return defineConfig([
    globalIgnores(['dist/', 'coverage/', 'node_modules/']),
    {
      // Exceptions live in `files:` overrides with a reason, where review sees them; never in
      // inline `eslint-disable` comments an agent can add to silence a rule.
      linterOptions: { noInlineConfig: true, reportUnusedDisableDirectives: 'error' },
    },

    // --- Every file: recommended JS + readability ---
    {
      files: [...TYPED_FILES, ...PLAIN_JS_FILES],
      extends: [js.configs.recommended],
      plugins: { '@stylistic': stylistic, sonarjs, unicorn, harness: harnessPlugin },
      languageOptions: { globals: globals.node },
      rules: {
        ...READABILITY_RULES,
        'no-console': 'error',
        'prefer-const': 'error',
        'object-shorthand': 'error',
        'max-params': ['error', 4],
        // Fail loudly: no catch that turns every error into a default (see the rule's message).
        'harness/no-silent-catch': 'error',
        // Typed errors only: no `new Error(...)`, so callers catch by class, not by message.
        'harness/no-raw-error': 'error',
        // "Is inside" checks that a folder named `..x/` can't fool.
        'harness/no-dotdot-prefix': 'error',
        // One clock (`now()`, through Luxon), so time can be fixed in a test.
        'harness/no-direct-clock': 'error',
        // Keys are read through `CredentialStore`, and only by the backend: nothing else names
        // the credentials file or imports the store. An exception is a `files:` override.
        'harness/no-credentials-file': 'error',
        'harness/no-key-holder-import': 'error',
      },
    },
    // --- A notice envelope is written by the core formatter only; tests assert on its text ---
    {
      files: SOURCE_FILES,
      ignores: testFiles,
      rules: { 'harness/no-handwritten-notice': 'error' },
    },
    // --- A notice enters history through `publishNotice`, by its kind's lifetime ---
    {
      files: SOURCE_FILES,
      ignores: testFiles,
      rules: { 'harness/no-adhoc-notice-entry': 'error' },
    },
    // --- The latest request in stored history is found through the core helpers, not by hand ---
    {
      files: SOURCE_FILES,
      ignores: testFiles,
      rules: { 'harness/no-adhoc-latest-request': 'error' },
    },
    // --- The main session is told by `isMainSession`, not by comparing its depth ---
    {
      files: SOURCE_FILES,
      ignores: testFiles,
      rules: { 'harness/no-adhoc-main-session': 'error' },
    },
    // --- An answer that finds its approval gone is `answerWhileWaiting`'s to forgive, not a match on the code ---
    {
      files: SOURCE_FILES,
      ignores: testFiles,
      rules: { 'harness/no-adhoc-unknown-approval': 'error' },
    },
    // --- Background work starts through `startWork` and a kind's factory, not `TaskRegistry.start` ---
    {
      files: SOURCE_FILES,
      ignores: testFiles,
      rules: { 'harness/no-direct-task-start': 'error' },
    },
    // --- A task kind's meaning is `isFiniteKind`'s, not a comparison; an app may show kinds apart ---
    ...(isApp
      ? []
      : [
          {
            files: SOURCE_FILES,
            ignores: testFiles,
            rules: { 'harness/no-adhoc-task-kind': 'error' },
          },
        ]),
    // --- An extension's declaration matches its workspace: folder and dependencies; its options are
    // choices, not run state the services already carry, and its source never takes the full
    // registries or builds a harness, with no exception ---
    ...(isExtension
      ? [
          {
            files: SOURCE_FILES,
            ignores: testFiles,
            rules: {
              'harness/extension-declares-grants': 'error',
              'harness/extension-definition': 'error',
              'harness/extension-options-use-services': 'error',
              'harness/extension-no-runtime-registries': 'error',
              'harness/extension-public-contract': 'error',
            },
          },
        ]
      : []),
    // --- Instruction context is appended by the instruction-hook factory only ---
    {
      files: SOURCE_FILES,
      ignores: testFiles,
      rules: {
        'harness/no-direct-instruction-context': 'error',
        'harness/no-raw-fs-in-instruction-source': 'error',
      },
    },
    // --- Files are written through storage (or a tool, on the agent's project): not in tests ---
    {
      files: SOURCE_FILES,
      ignores: testFiles,
      rules: { 'harness/no-direct-file-writes': 'error' },
    },
    // --- A model reply is read by the shared `readReply`, not a protocol's own event loop ---
    {
      files: SOURCE_FILES,
      ignores: testFiles,
      rules: { 'harness/no-handrolled-reply-reader': 'error' },
    },
    // --- Model calls go out through `createModelFetch`, never Node's global fetch ---
    {
      files: SOURCE_FILES,
      ignores: testFiles,
      rules: { 'harness/no-raw-model-fetch': 'error' },
    },
    // --- The server's runtime folder and discovery file are resolved in storage, not rebuilt ---
    {
      files: SOURCE_FILES,
      ignores: testFiles,
      rules: { 'harness/no-discovery-path': 'error' },
    },
    // --- A client of the running server finds it only through the finder and its handshake ---
    {
      files: SOURCE_FILES,
      ignores: testFiles,
      rules: { 'harness/server-through-finder': 'error' },
    },
    // --- A file changed whole goes through LockedChange, not a bare in-process queue ---
    {
      files: SOURCE_FILES,
      ignores: testFiles,
      rules: { 'harness/no-raw-serial-queue': 'error' },
    },

    // --- TypeScript: strict + stylistic, type-aware ---
    {
      files: TYPED_FILES,
      extends: [tseslint.configs.strictTypeChecked, tseslint.configs.stylisticTypeChecked],
      languageOptions: {
        parserOptions: {
          projectService: { allowDefaultProject: DEFAULT_PROJECT_FILES },
          tsconfigRootDir,
        },
      },
      rules: {
        ...TYPESCRIPT_RULES,
        // A branded id (`SessionId`) is parsed into being, never asserted; tests included.
        'harness/no-brand-cast': 'error',
      },
    },

    // --- Conventions ---
    {
      files: SOURCE_FILES,
      rules: {
        'harness/no-default-export': 'error',
        'harness/no-process-env': 'error',
        'harness/params-object': 'error',
        'harness/no-barrel': 'error',
        // A type a workspace package exports is defined there only; the packages and their types
        // are read from the workspace, so new ones are covered without editing the rule.
        'harness/single-definition': 'error',
        // Only the canonical host prompt anchor reads tool sources and requires a review record.
        'harness/system-prompt-review': 'error',
        // Every workspace holds together as the layout reads it from the workspaces.
        'harness/layout': 'error',
        // Imports follow the layout's graph; tests are checked too.
        'harness/imports': 'error',
      },
    },

    // Authored model-facing text has a reviewable home; runtime/user data stays at the caller.
    {
      files: SOURCE_FILES,
      ignores: testFiles,
      rules: { 'harness/prompt-location': 'error' },
    },

    // --- React: a hook is called only from a component or another hook, with its dependencies ---
    {
      files: SOURCE_FILES,
      // Plain test lifecycle helpers named use* are not React hooks; JSX tests remain checked.
      ignores: [`**/${TEST_FOLDER}/**/*.ts`, 'src/testing/**/*.ts'],
      plugins: { 'react-hooks': reactHooks },
      rules: { 'react-hooks/rules-of-hooks': 'error', 'react-hooks/exhaustive-deps': 'error' },
    },

    // --- Backend only: no terminal I/O outside an app ---
    {
      files: SOURCE_FILES,
      ignores: [...frontEndFiles, ...testFiles],
      rules: { 'harness/no-terminal-io': 'error' },
    },
    // --- An app: a host and a front end. It reads env and prints, which a backend never does ---
    ...(isApp
      ? [{ files: SOURCE_FILES, rules: { 'harness/no-process-env': 'off', 'no-console': 'off' } }]
      : []),

    // --- Structure: `<name>.<kind>.ts`, each kind exports one shape, utils and validators stay pure ---
    {
      files: SOURCE_FILES,
      ignores: entryFiles,
      rules: { 'harness/file-kind': 'error', 'harness/kind-contents': 'error' },
    },
    { files: TYPED_FILES, rules: { 'max-lines': maxLines(DEFAULT_MAX_LINES) } },
    ...maxLinesPerKind,
    {
      files: ['src/**/*.utils.ts', 'src/**/*.validator.ts', 'src/**/*.prompt.ts'],
      rules: { 'harness/pure-imports': 'error' },
    },
    // Ids are branded: in zod schemas, and in the types of source (`agentId: string`). Tests and
    // fakes keep fixtures, and a prompt renderer takes the text it prints.
    {
      files: SOURCE_FILES,
      ignores: testFiles,
      rules: { 'harness/branded-ids': 'error' },
    },
    {
      files: ['src/**/*.prompt.ts'],
      ignores: testFiles,
      rules: { 'harness/branded-ids': ['error', { types: false }] },
    },

    // --- Tests: may set env, assert known shapes, and repeat setup by design ---
    {
      files: testFiles,
      rules: {
        'harness/no-process-env': 'off',
        // Local helpers (`sleep(ms)`, `waitFor(check, ms)`) read fine positionally.
        'harness/params-object': 'off',
        '@typescript-eslint/no-non-null-assertion': 'off',
        'max-nested-callbacks': ['error', 4], // describe → it → callback → inner callback
      },
    },

    // --- Plain JS (configs, scripts, hooks): untyped, but still never on deprecated APIs ---
    // The type-aware rule sets stay off (JS has no annotations to check), yet the parser gets
    // type info so `no-deprecated` can see `@deprecated` on Node and library APIs. Loose files
    // (configs, `.cursor/hooks`) use the default project; a package of JS has a tsconfig.
    {
      files: PLAIN_JS_FILES,
      extends: [tseslint.configs.disableTypeChecked],
      languageOptions: {
        parser: tseslint.parser,
        parserOptions: {
          projectService: { allowDefaultProject: DEFAULT_PROJECT_FILES },
          tsconfigRootDir,
        },
      },
      plugins: { '@typescript-eslint': tseslint.plugin },
      rules: { '@typescript-eslint/no-deprecated': 'error' },
    },

    // --- Formatting is owned by Prettier (.prettierrc.json); keep ESLint out of it ---
    prettier,
    // Re-applied after eslint-config-prettier, which would otherwise switch `curly` off.
    { files: [...TYPED_FILES, ...PLAIN_JS_FILES], rules: { curly: READABILITY_RULES.curly } },
  ]);
}

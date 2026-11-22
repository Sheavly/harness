// Every workspace gets the harness rules, so a new package can't skip them. The shared config is
// the source of truth: whatever `baseConfig` enables in a synthetic workspace (named like nothing
// in this repo) must be enabled in every real one, on a module file at a path no workspace
// special-cases. Each workspace also needs the scripts turbo runs, since turbo silently skips a
// workspace without one. The workspaces are read from the root `package.json`, never listed here.
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { ESLint } from 'eslint';
import { describe, expect, it } from 'vitest';
import { workspaceDirs } from '../rules/workspace-types.js';

const REPO_ROOT = path.resolve(import.meta.dirname, '../../../..');
const BASE_CONFIG = pathToFileURL(path.join(import.meta.dirname, '..', 'base.js')).href;
/** A module file of a kind every rule applies to, in a folder no workspace special-cases. */
const PROBE = 'src/zz-probe/zz-probe.utils.ts';
const REQUIRED_SCRIPTS = ['typecheck', 'lint', 'test'];

function readJson(file) {
  return JSON.parse(readFileSync(file, 'utf8'));
}

const eslintByDir = new Map();
const configByFile = new Map();

/**
 * The resolved config of a file, computed once per file for the whole run: the tests of a workspace
 * ask about the same files, and resolving a config is what makes this suite slow. Safe to share,
 * as nothing here changes a config file while the tests run.
 */
function configFor(dir, file) {
  if (!eslintByDir.has(dir)) eslintByDir.set(dir, new ESLint({ cwd: dir }));

  const key = `${dir}\0${file}`;

  if (!configByFile.has(key)) {
    configByFile.set(key, eslintByDir.get(dir).calculateConfigForFile(file));
  }

  return configByFile.get(key);
}

async function enabledRules(dir) {
  const config = await configFor(dir, path.join(dir, PROBE));
  const severity = (entry) => (Array.isArray(entry) ? entry[0] : entry);

  return Object.entries(config?.rules ?? {})
    .filter(([, entry]) => ![0, 'off'].includes(severity(entry)))
    .map(([rule]) => rule)
    .sort();
}

/**
 * A workspace that only calls `baseConfig`: what every workspace gets at the least. A test-only
 * one (`sheavly.testOnly`, like `@sheavly/testing`) has the test rules on all its source; an app
 * may read env, print and use the terminal.
 */
async function baselineRules(params = {}) {
  const { testOnly = false, app = false } = params;
  const parent = mkdtempSync(path.join(tmpdir(), 'zz-synthetic-workspace-'));
  // An app is a workspace in an `apps/` folder: baseConfig reads that from where it is.
  const dir = path.join(parent, app ? 'apps' : 'packages', 'zz');

  mkdirSync(path.join(dir, 'src'), { recursive: true });
  writeFileSync(path.join(dir, 'tsconfig.json'), JSON.stringify({ include: ['src'] }));
  writeFileSync(
    path.join(dir, 'package.json'),
    JSON.stringify({ name: 'zz', sheavly: { testOnly } }),
  );
  writeFileSync(
    path.join(dir, 'eslint.config.js'),
    `import { baseConfig } from '${BASE_CONFIG}';\n\nexport default baseConfig({ tsconfigRootDir: import.meta.dirname });\n`,
  );

  return enabledRules(dir);
}

const isTestOnly = (dir) => readJson(path.join(dir, 'package.json')).sheavly?.testOnly === true;
const isApp = (dir) => path.basename(path.dirname(dir)) === 'apps';
const isTooling = (dir) => readJson(path.join(dir, 'package.json')).sheavly?.domain === 'tooling';
/** What only an app may do: read env, use the terminal, print. */
const APP_ONLY_RULES = ['harness/no-process-env', 'harness/no-terminal-io', 'no-console'];
const isOn = (entry) => {
  const severity = Array.isArray(entry) ? entry[0] : entry;

  return severity === 2 || severity === 'error' || severity === 1 || severity === 'warn';
};
/** The one module allowed to name the credentials file: its folder in `@sheavly/storage`. */
const CREDENTIAL_STORE_FILES = /^packages[/\\]storage[/\\]src[/\\]credential-store[/\\]/;
/**
 * Where the server's runtime folder and discovery file are resolved: storage's two folders, and
 * the protocol's constant that holds the file's name.
 */
const DISCOVERY_PATH_FILES =
  /^packages[/\\](storage[/\\]src[/\\](server-runtime|discovery-file)[/\\]|protocol[/\\]src[/\\]discovery[/\\])/;
/** The one workspace allowed to import the credential store. */
const BACKEND_FILES = /^apps[/\\]backend[/\\]/;
/**
 * The only source files that may write a file by hand: the storage primitives every store writes
 * through (the one-server lock, its runtime folder and the discovery file, which make and remove
 * their files on purpose; and the output store's two files, which append a command's output as it arrives), the
 * agent's file-tool helper, the backend's model-call debug log, and the terminal's
 * developer tooling (its workbook, and `saveRawStream`, which the demo and the recorder share), and the workspace's two scratch helpers, which create
 * the shared scratch folder and remove its stale entries (no user data; the same folder is exempt
 * in `packages/workspace/eslint.config.js`), and the confined reader, which calls `fs.open` with
 * `O_RDONLY` only to read through the open handle (`open` is on the rule's list because it can
 * write; this one never does). Anything else goes through `@sheavly/storage`.
 */
const FILE_WRITERS = new RegExp(
  [
    '^packages[/\\\\]storage[/\\\\]src[/\\\\](json-file|jsonl-file|safe-path|file-lock|server-lock|server-runtime|discovery-file)[/\\\\]',
    '^packages[/\\\\]storage[/\\\\]src[/\\\\]output-store[/\\\\]output-(store|writer)\\.service\\.ts$',
    '^extensions[/\\\\]coding[/\\\\]src[/\\\\]files[/\\\\]file-effects\\.helper\\.ts$',
    '^packages[/\\\\]workspace[/\\\\]src[/\\\\]scratch[/\\\\]scratch(-root)?\\.helper\\.ts$',
    '^packages[/\\\\]workspace[/\\\\]src[/\\\\]instruction-context[/\\\\]confined-read\\.helper\\.ts$',
    '^apps[/\\\\]backend[/\\\\]src[/\\\\]harness[/\\\\]model-calls\\.helper\\.ts$',
    '^apps[/\\\\]terminal[/\\\\]src[/\\\\](client[/\\\\]raw-stream\\.helper\\.ts$|workbook[/\\\\](recorder\\.service|store\\.service|check\\.helper)\\.ts$)',
  ].join('|'),
);

/** A workspace's TypeScript, tests and fakes included. */
function typescriptFiles(dir) {
  return readdirSync(dir, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile() && /\.[cm]?tsx?$/.test(entry.name))
    .map((entry) => path.join(entry.parentPath, entry.name));
}

/**
 * The files of a workspace's `src/` that have `rule` off and are not among those `allowed`. With
 * `sourceOnly`, tests and fakes are left out: some rules are for the code that runs, and are off
 * for the fixtures a test writes into a temp folder.
 */
async function filesWithRuleOff(params) {
  const { dir, rule, allowed, sourceOnly = false } = params;
  const off = [];
  const files = sourceOnly
    ? sourceFiles(path.join(dir, 'src'))
    : typescriptFiles(path.join(dir, 'src'));

  for (const file of files) {
    const { rules } = await configFor(dir, file);

    if (!isOn(rules[rule])) off.push(path.relative(REPO_ROOT, file));
  }

  return off.filter((file) => !allowed.test(file));
}

/** A workspace's TypeScript source outside tests and fakes. */
function sourceFiles(dir) {
  return typescriptFiles(dir).filter((file) => !/[/\\](__tests__|testing)[/\\]/.test(file));
}

const WORKSPACES = workspaceDirs(REPO_ROOT);
const BASELINE = await baselineRules();
const TEST_ONLY_BASELINE = await baselineRules({ testOnly: true });
const APP_BASELINE = await baselineRules({ app: true });

/** What a workspace of this kind gets from the shared config alone. */
function baselineFor(dir) {
  if (isTestOnly(dir)) return TEST_ONLY_BASELINE;

  return isApp(dir) ? APP_BASELINE : BASELINE;
}

it('reads the packages and the apps from the root workspaces', () => {
  expect(WORKSPACES.some((dir) => isApp(dir))).toBe(true);
  expect(WORKSPACES.some((dir) => !isApp(dir))).toBe(true);
});

it('lets an app, and only an app, read env, print and use the terminal', () => {
  expect(BASELINE).toEqual(expect.arrayContaining(APP_ONLY_RULES));
  expect(APP_BASELINE.filter((rule) => APP_ONLY_RULES.includes(rule))).toEqual([]);
});

it('gets the harness rules from the shared config alone', () => {
  expect(BASELINE).toEqual(
    expect.arrayContaining([
      'harness/file-kind',
      'harness/kind-contents',
      'harness/pure-imports',
      'harness/single-definition',
      'harness/layout',
      'harness/imports',
      'harness/no-raw-error',
      'harness/no-silent-catch',
    ]),
  );
});

describe.each(WORKSPACES.map((dir) => [path.relative(REPO_ROOT, dir) || '.', dir]))(
  '%s',
  (name, dir) => {
    it('has an eslint.config.js', () => {
      expect(
        existsSync(path.join(dir, 'eslint.config.js')),
        'Add one calling `baseConfig({ tsconfigRootDir: import.meta.dirname })` from @sheavly/eslint-config.',
      ).toBe(true);
    });

    it('enables every rule the shared config does', async () => {
      const enabled = new Set(await enabledRules(dir));

      expect(
        baselineFor(dir).filter((rule) => !enabled.has(rule)),
        `${name} turns off shared rules. Keep them on; a justified exception is a files: override with a reason, on the files it is for.`,
      ).toEqual([]);
    });

    // A package is a library: env comes in as options, and only an app prints or uses the
    // terminal. Checked on every source file, so a `files:` override can't carve one out.
    // Tooling (the ESLint config) and test-only packages never run inside the harness.
    it.skipIf(isApp(dir) || isTestOnly(dir) || isTooling(dir))(
      'keeps env, the terminal and printing out of every source file',
      async () => {
        const files = sourceFiles(path.join(dir, 'src'));
        const off = [];

        for (const file of files) {
          const { rules } = await configFor(dir, file);

          for (const rule of APP_ONLY_RULES) {
            if (!isOn(rules[rule])) off.push(`${path.relative(dir, file)}: ${rule}`);
          }
        }

        expect(
          off,
          `${name} turns these off for some files. Only an app reads env or does terminal I/O: take the value as an option, and let the app pass it in.`,
        ).toEqual([]);
      },
    );

    // Only the credential store may name the credentials file, and only the backend app may import
    // the store. Pinned here, so an override that widens an exception (a whole workspace, its
    // tests) fails this instead of passing quietly.
    it('keeps the credentials file named only inside the credential store', async () => {
      expect(
        await filesWithRuleOff({
          dir,
          rule: 'harness/no-credentials-file',
          allowed: CREDENTIAL_STORE_FILES,
        }),
        `${name} lets files outside the credential store name the credentials file. Go through CredentialStore (apps/backend only) instead of turning \`harness/no-credentials-file\` off.`,
      ).toEqual([]);
    });

    it('keeps the server runtime folder and the discovery file named only where they are resolved', async () => {
      expect(
        await filesWithRuleOff({
          dir,
          rule: 'harness/no-discovery-path',
          allowed: DISCOVERY_PATH_FILES,
          sourceOnly: true,
        }),
        `${name} lets files outside the server runtime and discovery file folders name the runtime variable or the discovery file. Import serverRuntimeDirectory, the discovery file module or DISCOVERY_FILE_NAME instead of turning \`harness/no-discovery-path\` off.`,
      ).toEqual([]);
    });

    // The rule itself exempts the server and storage; no `files:` override may carve out more.
    it('keeps every source file on the server finder', async () => {
      expect(
        await filesWithRuleOff({
          dir,
          rule: 'harness/server-through-finder',
          allowed: /$^/,
          sourceOnly: true,
        }),
        `${name} turns \`harness/server-through-finder\` off for some files. Reach the running server through findRunningServer with verifyServer instead.`,
      ).toEqual([]);
    });

    it('keeps the key holders imported only by the backend app', async () => {
      expect(
        await filesWithRuleOff({
          dir,
          rule: 'harness/no-key-holder-import',
          allowed: BACKEND_FILES,
        }),
        `${name} lets files outside the backend app import the credential store or the profile registry. Only the backend reads a key: ask it over the API, or take the secret as an option.`,
      ).toEqual([]);
    });

    // Files are written in a few named places. Pinned here, so an override that widens the
    // exception (a whole workspace, its tests, one more file) fails this instead of passing
    // quietly: a new writer is added to `FILE_WRITERS` in review, with a reason.
    it('keeps hand-rolled file writes to the few modules that are for it', async () => {
      expect(
        await filesWithRuleOff({
          dir,
          rule: 'harness/no-direct-file-writes',
          allowed: FILE_WRITERS,
          sourceOnly: true,
        }),
        `${name} lets files outside the storage primitives write files by hand. Write the user's data through @sheavly/storage (writeJsonFile, DocumentFile, a store), and a project through the agent's file tools; do not turn \`harness/no-direct-file-writes\` off for more files.`,
      ).toEqual([]);
    });

    it.skipIf(isApp(dir) || isTooling(dir))(
      'keeps metadata-based import boundaries enabled on every package source file',
      async () => {
        expect(
          await filesWithRuleOff({
            dir,
            rule: 'harness/imports',
            allowed: /$^/,
            sourceOnly: true,
          }),
          `${name} disables harness/imports for source. Keep marked app-only implementations injected by apps, including from package tools.`,
        ).toEqual([]);
      },
    );

    it('has the scripts turbo runs', () => {
      const scripts = readJson(path.join(dir, 'package.json')).scripts ?? {};

      expect(
        REQUIRED_SCRIPTS.filter((script) => !scripts[script]),
        'Add them like the other packages (`tsc --noEmit`, `eslint .`, `vitest run --config ../../vitest.config.ts`).',
      ).toEqual([]);
    });
  },
);

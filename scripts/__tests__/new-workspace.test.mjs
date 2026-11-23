import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { ESLint } from 'eslint';
import { afterEach, describe, expect, it } from 'vitest';
import { harnessPlugin } from '../../packages/eslint-config/src/plugin.js';
import { findLayoutProblems } from '../check-layout.mjs';
import { createWorkspace, installCommands, planWorkspace } from '../new-workspace.mjs';
import { createTempRepo, removeTempRepos } from './temp-repo.utils.mjs';

afterEach(removeTempRepos);

const json = (value) => JSON.stringify(value);
const ESLINT =
  "import { baseConfig } from '@sheavly/eslint-config';\n\nexport default baseConfig({ tsconfigRootDir: import.meta.dirname });\n";
const TSCONFIG = json({ extends: '../../tsconfig.base.json', compilerOptions: { rootDir: 'src' } });

/** A monorepo with two packages, `core` (generic) and `coding` (coding), and an app, `web`. */
const WORKSPACES = { core: 'packages', coding: 'packages', web: 'apps' };
const fileOf = (folder, file) => `${WORKSPACES[folder]}/${folder}/${file}`;
const repoFiles = (folder) =>
  [
    'package.json',
    'eslint.config.js',
    'tsconfig.json',
    'README.md',
    'docs/design.md',
    `src/${folder}/${folder}.utils.ts`,
  ].map((file) => fileOf(folder, file));

function repo(params = {}) {
  const { workspaces = ['packages/*', 'apps/*'], versions = {} } = params;

  const pkg = (folder, domain) => ({
    [fileOf(folder, 'package.json')]: json({
      ...(WORKSPACES[folder] === 'packages' && {
        exports: {},
        files: ['dist', 'docs'],
        scripts: { prepack: 'npm run build' },
      }),
      name: `@sheavly/${folder}`,
      version: versions[folder] ?? '0.0.0',
      sheavly: { domain },
    }),
    [fileOf(folder, 'eslint.config.js')]: ESLINT,
    [fileOf(folder, 'tsconfig.json')]: TSCONFIG,
    [fileOf(folder, `src/${folder}/${folder}.utils.ts`)]: 'export {};\n',
    [fileOf(folder, 'README.md')]: '# x\n\n## Docs\n\n- [Design](docs/design.md)\n',
    [fileOf(folder, 'docs/design.md')]: '# Design\n',
  });

  // npm runs in it for real, so it gets no link to this repo's node_modules.
  return createTempRepo(
    {
      'package.json': json({
        name: 'monorepo',
        private: true,
        workspaces,
      }),
      '.prettierrc.json': json({ singleQuote: true, printWidth: 100 }),
      ...pkg('core', 'generic'),
      ...pkg('coding', 'coding'),
      ...pkg('web', 'coding'),
    },
    { linkNodeModules: false },
  );
}

const plan = (root, fields) =>
  planWorkspace({ root, domain: 'generic', description: 'What it is for', ...fields });

describe('planning a workspace', () => {
  it('refuses a dependency the graph does not allow, before anything changes', () => {
    const root = repo();

    expect(plan(root, { kind: 'package', name: 'kit', dependsOn: ['coding'] }).problems).toEqual([
      '@sheavly/kit is generic but depends on @sheavly/coding, a coding workspace',
    ]);
    expect(plan(root, { kind: 'package', name: 'kit', dependsOn: ['web'] }).problems).toEqual([
      '@sheavly/kit depends on @sheavly/web, an app: nothing imports an app',
    ]);
    expect(plan(root, { kind: 'package', name: 'kit', dependsOn: ['gone'] }).problems).toEqual([
      "@sheavly/kit depends on @sheavly/gone, which isn't a workspace",
    ]);
    expect(plan(root, { kind: 'package', name: 'kit', dependsOn: ['kit'] }).problems).toEqual([
      "@sheavly/kit depends on @sheavly/kit, which isn't a workspace",
    ]);
  });

  it('refuses a bad kind, name, domain or description, and a workspace that exists', () => {
    const root = repo();

    expect(
      plan(root, { kind: 'lib', name: 'Kit', domain: 'misc', description: ' ' }).problems,
    ).toEqual([
      'the kind is `package`, `extension` or `app`, not `lib`',
      'the name is kebab-case (`road-segments`), not `Kit`',
      '--domain is one of generic, coding, tooling',
      '--description says what the workspace is for, in one line',
    ]);
    expect(plan(root, { kind: 'package', name: 'core' }).problems).toEqual([
      'packages/core (@sheavly/core) already exists',
    ]);
  });

  it('allows a dependency down the graph, and says how to install it with its first import', () => {
    const planned = plan(repo(), { kind: 'package', name: 'kit', dependsOn: ['core'] });

    expect(planned.problems).toEqual([]);
    expect(installCommands(planned)).toEqual(['npm install @sheavly/core@0.0.0 -w packages/kit']);
  });

  it('names the version a dependency has now, not the first one: a pinned one stops matching when it moves', () => {
    const planned = plan(repo({ versions: { core: '0.3.1' } }), {
      kind: 'package',
      name: 'kit',
      dependsOn: ['core'],
    });

    expect(installCommands(planned)).toEqual(['npm install @sheavly/core@0.3.1 -w packages/kit']);
  });
});

describe('creating a workspace', () => {
  it.each([
    ['package', 'kit', 'generic', ['core']],
    ['app', 'cli', 'coding', ['coding']],
  ])(
    'creates a %s the layout check accepts, once it has a module',
    async (kind, name, domain, dependsOn) => {
      const root = repo();
      const planned = plan(root, { kind, name, domain, dependsOn });
      const dir = `${kind === 'app' ? 'apps' : 'packages'}/${name}`;

      await createWorkspace({ root, plan: planned });

      const manifest = JSON.parse(readFileSync(path.join(root, dir, 'package.json'), 'utf8'));
      const files = [
        'package.json',
        ...['core', 'coding', 'web'].flatMap((folder) => repoFiles(folder)),
        ...[
          'package.json',
          'eslint.config.js',
          'tsconfig.json',
          'tsconfig.build.json',
          'README.md',
          'docs/design.md',
        ].map((file) => `${dir}/${file}`),
      ];

      expect(manifest).toMatchObject({
        name: `@sheavly/${name}`,
        private: true,
        sheavly: { domain },
      });
      expect(manifest.dependencies).toBeUndefined(); // installed with its first import
      // The lockfile and the node_modules link know it by its new name, not npm init's folder name.
      const lock = JSON.parse(readFileSync(path.join(root, 'package-lock.json'), 'utf8'));

      expect(lock.packages[dir].name).toBe(`@sheavly/${name}`);
      expect(lock.packages[`node_modules/@sheavly/${name}`]).toMatchObject({
        resolved: dir,
        link: true,
      });
      expect(lock.packages[`node_modules/${name}`]).toBeUndefined();
      // Until its first module lands, the only problem is that it has none.
      expect(findLayoutProblems({ root, files })).toEqual([
        expect.stringContaining(`${dir}: has no source yet`),
      ]);
    },
  );

  it('plans an extension in extensions/, built on packages, and creates it with a public API like a package', async () => {
    const root = repo({ workspaces: ['packages/*', 'apps/*'] });
    const planned = plan(root, { kind: 'extension', name: 'notes', dependsOn: ['core'] });

    expect(planned.problems).toEqual([]);
    expect(planned.dir).toBe('extensions/notes');
    expect(installCommands(planned)).toEqual([
      'npm install @sheavly/core@0.0.0 -w extensions/notes',
    ]);

    await createWorkspace({ root, plan: planned });

    const read = (file) => JSON.parse(readFileSync(path.join(root, file), 'utf8'));

    expect(read('package.json').workspaces).toEqual(['packages/*', 'apps/*', 'extensions/*']);
    expect(read('extensions/notes/package.json')).toMatchObject({
      name: '@sheavly/notes',
      // The repo's own license, so a scaffolded workspace is not the one UNLICENSED package.
      license: 'Apache-2.0',
      exports: {},
      files: ['dist', 'docs', 'sheavly.json'],
      scripts: { prepack: 'npm run build' },
    });
    expect(read('extensions/notes/sheavly.json')).toEqual({
      $schema: '../../packages/extension/sheavly.schema.json',
      name: 'notes',
      dependsOn: [],
    });
  });

  it('creates an extension that passes the layout check and the extension-definition rule', async () => {
    const root = repo({ workspaces: ['packages/*', 'apps/*'] });
    // Plain JavaScript, so the default parser reads it: the rule looks at the call, not the syntax.
    const helper = 'extensions/notes/src/notes/notes.helper.js';

    await createWorkspace({
      root,
      plan: plan(root, { kind: 'extension', name: 'notes' }),
    });
    mkdirSync(path.join(root, path.dirname(helper)), { recursive: true });
    writeFileSync(
      path.join(root, helper),
      "import { readManifest } from '@sheavly/extension/manifest/manifest.helper';\ndefineExtension({ manifest: readManifest(new URL('../../sheavly.json', import.meta.url)), activate });\n",
      { flag: 'wx' },
    );

    const files = [
      'package.json',
      ...['core', 'coding', 'web'].flatMap((folder) => repoFiles(folder)),
      helper,
      ...[
        'package.json',
        'sheavly.json',
        'eslint.config.js',
        'tsconfig.json',
        'tsconfig.build.json',
      ]
        .concat(['README.md', 'docs/design.md'])
        .map((file) => `extensions/notes/${file}`),
    ];
    const [result] = await new ESLint({
      cwd: root,
      overrideConfigFile: true,
      overrideConfig: [
        {
          files: ['**/*.js'],
          plugins: { harness: harnessPlugin },
          rules: { 'harness/extension-definition': ['error', { root }] },
        },
      ],
    }).lintFiles([helper]);

    expect(result?.messages).toEqual([]);
    expect(findLayoutProblems({ root, files })).toEqual([]);
  });

  it('refuses an extension that depends on an app, as a package would', () => {
    expect(plan(repo(), { kind: 'extension', name: 'notes', dependsOn: ['web'] }).problems).toEqual(
      ['@sheavly/notes depends on @sheavly/web, an app: nothing imports an app'],
    );
  });

  it('adds apps/* to the root workspaces the first time, through npm', async () => {
    const root = repo({ workspaces: ['packages/*'] });

    await createWorkspace({
      root,
      plan: plan(root, { kind: 'app', name: 'cli', domain: 'coding' }),
    });

    expect(JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8')).workspaces).toEqual([
      'packages/*',
      'apps/*',
    ]);
  });

  it('writes package.json only through npm', async () => {
    const root = repo();
    const calls = [];

    await createWorkspace({
      root,
      plan: plan(root, { kind: 'package', name: 'kit' }),
      npm: (args) => calls.push(args),
    });

    expect(calls.map((args) => args.slice(0, 2).join(' '))).toEqual([
      'init -y',
      'pkg delete',
      'pkg set',
      'pkg set',
      'pkg set', // exports={}: its public API starts empty
      'pkg set', // files: its build and docs
      'pkg set', // scripts.prepack: built before it packs
      'install --no-audit',
    ]);
  });
});

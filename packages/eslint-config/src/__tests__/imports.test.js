import path from 'node:path';
import { RuleTester } from 'eslint';
import tseslint from 'typescript-eslint';
import { afterAll, describe, it } from 'vitest';
import { harnessPlugin } from '../plugin.js';
import { tempWorkspace } from '../testing/workspace.fake.js';

RuleTester.afterAll = afterAll;
RuleTester.describe = describe;
RuleTester.it = it;

const root = tempWorkspace({
  'package.json': { name: 'monorepo', workspaces: ['packages/*', 'apps/*'] },
  'packages/protocol/package.json': { name: '@x/protocol' },
  'packages/core/package.json': { name: '@x/core' },
  'packages/coding/package.json': { name: '@x/coding' },
  'packages/testing/package.json': { name: '@x/testing' },
  'packages/coding2/package.json': { name: '@x/coding2' },
  'apps/cli/package.json': { name: '@x/cli' },
  'apps/web/package.json': { name: '@x/web' },
  'apps/launch/package.json': { name: 'launch' },
});
/** The `exports` of a package that makes these file kinds public, plus its fakes if listed. */
const kinds = (...names) =>
  Object.fromEntries(
    names.map((kind) => [
      kind === 'testing' ? './testing/*' : `./*.${kind}`,
      kind === 'testing'
        ? { '@sheavly/source': './src/testing/*.ts' }
        : { '@sheavly/source': `./src/*.${kind}.ts`, default: `./dist/*.${kind}.js` },
    ]),
  );
const layout = {
  '@x/protocol': {
    dir: 'packages/protocol',
    kind: 'package',
    domain: 'generic',
    dependsOn: [],
    exports: kinds('utils'),
  },
  '@x/core': {
    dir: 'packages/core',
    kind: 'package',
    domain: 'generic',
    dependsOn: ['@x/protocol'],
    exports: kinds('utils', 'testing'),
  },
  '@x/coding': {
    dir: 'packages/coding',
    kind: 'package',
    domain: 'coding',
    dependsOn: ['@x/core'],
    devDependsOn: ['@x/testing', '@x/protocol'],
    exports: kinds('utils', 'tool'),
  },
  '@x/testing': {
    dir: 'packages/testing',
    kind: 'package',
    domain: 'generic',
    testOnly: true,
    dependsOn: [],
    exports: kinds('fake'),
  },
  '@x/coding2': {
    dir: 'packages/coding2',
    kind: 'package',
    domain: 'coding',
    dependsOn: ['@x/coding'],
    exports: {},
  },
  '@x/cli': { dir: 'apps/cli', kind: 'app', domain: 'coding', dependsOn: ['@x/core', '@x/coding'] },
  '@x/web': {
    dir: 'apps/web',
    kind: 'app',
    domain: 'coding',
    dependsOn: ['@x/core'],
    exports: {
      './run/run.helper': {
        '@sheavly/source': './src/run/run.helper.ts',
        default: './dist/run/run.helper.js',
      },
    },
  },
  launch: {
    dir: 'apps/launch',
    kind: 'app',
    domain: 'coding',
    launcher: true,
    dependsOn: ['@x/web'],
  },
};
const at = (file) => path.join(root, file);
const options = [{ root, layout }];
const CORE_FILE = at('packages/core/src/tool/tool.utils.ts');
const CODING_FILE = at('packages/coding/src/files/files.utils.ts');
const CLI_TEST = at('apps/cli/src/main/__tests__/main.test.ts');

const error = (messageId) => [{ messageId }];

new RuleTester({ languageOptions: { parser: tseslint.parser } }).run(
  'imports',
  harnessPlugin.rules.imports,
  {
    valid: [
      // Along the graph: down, by package name, and a package importing itself.
      { code: "import { x } from '@x/protocol/a/a.utils';", filename: CORE_FILE },
      { code: "import { x } from '@x/core/tool/tool.utils';", filename: CODING_FILE },
      { code: "import { x } from '@x/core/tool/tool.utils';", filename: CORE_FILE },
      {
        code: "import { x } from '@x/coding/files/files.utils';",
        filename: at('apps/cli/src/main.ts'),
      },
      // Libraries are not ours to check; a relative import inside a workspace is fine.
      { code: "import { z } from 'zod';", filename: CORE_FILE },
      { code: "import { y } from '../message/message.types.js';", filename: CORE_FILE },
      // The test-only package from a test.
      {
        code: "import { fake } from '@x/testing/fake/fake.fake';",
        filename: at('packages/coding/src/files/__tests__/files.utils.test.ts'),
      },
      // A dev dependency from a test.
      {
        code: "import { x } from '@x/protocol/a/a.utils';",
        filename: at('packages/coding/src/files/__tests__/files.utils.test.ts'),
      },
      // A relative import within the app.
      { code: "import { x } from '../../main/main.helper.js';", filename: CLI_TEST },
      // A tool built on another tool of its package.
      {
        code: "import { createReadTool } from '../read/read.tool.js';",
        filename: at('packages/coding/src/write/write.tool.ts'),
      },
      // An app, or a test, including a package's tool in a run.
      {
        code: "import { createReadTool } from '@x/coding/read/read.tool';",
        filename: at('apps/cli/src/main.ts'),
      },
      {
        code: "import { createReadTool } from '@x/coding/read/read.tool';",
        filename: at('apps/cli/src/main/__tests__/main.test.ts'),
      },
      // The launcher running an app through the entry file the app exports.
      {
        code: "import { run } from '@x/web/run/run.helper';",
        filename: at('apps/launch/src/main/main.helper.ts'),
      },
      // A package's fakes, from a test.
      {
        code: "import { echo } from '@x/core/testing/echo-tool.fake';",
        filename: at('packages/coding/src/files/__tests__/files.utils.test.ts'),
      },
    ].map((test) => ({ ...test, options })),
    invalid: [
      // A module the package doesn't export: not its public API, from source or a test.
      {
        code: "import { x } from '@x/core/tool/tool.helper';",
        filename: CODING_FILE,
        errors: error('notExported'),
      },
      {
        code: "import { x } from '@x/core/tool/tool.helper';",
        filename: at('packages/coding/src/files/__tests__/files.utils.test.ts'),
        errors: error('notExported'),
      },
      // A package putting another workspace's tool into a run: that's the UI's choice.
      {
        code: "import { createReadTool } from '@x/coding/read/read.tool';",
        filename: at('packages/coding2/src/preset/preset.helper.ts'),
        errors: error('composesRun'),
      },
      // The same from its own package: a helper putting the package's tools together.
      {
        code: "import { createReadTool } from '../read/read.tool.js';",
        filename: at('packages/coding/src/preset/preset.helper.ts'),
        errors: error('composesRun'),
      },
      // A package's fakes from source.
      {
        code: "import { echo } from '@x/core/testing/echo-tool.fake';",
        filename: CODING_FILE,
        errors: error('fakeInSource'),
      },
      // Upward: core importing a package above it.
      {
        code: "import { x } from '@x/coding/files/files.utils';",
        filename: CORE_FILE,
        errors: error('notInGraph'),
      },
      // A dev dependency from source: only tests may import it.
      {
        code: "import { x } from '@x/protocol/a/a.utils';",
        filename: CODING_FILE,
        errors: error('notInGraph'),
      },
      // A package importing an app.
      {
        code: "import { x } from '@x/cli/main';",
        filename: CODING_FILE,
        errors: error('notInGraph'),
      },
      // A generic package importing a coding one.
      {
        code: "export { x } from '@x/coding/files/files.utils';",
        filename: at('packages/protocol/src/a/a.utils.ts'),
        errors: error('notInGraph'),
      },
      // An app importing another app.
      {
        code: "import { x } from '@x/web/main';",
        filename: at('apps/cli/src/main.ts'),
        errors: error('notInGraph'),
      },
      // The launcher reaching into an app past its exported entry files.
      {
        code: "import { x } from '@x/web/main/main.helper';",
        filename: at('apps/launch/src/main/main.helper.ts'),
        errors: error('notExported'),
      },
      // An app the launcher doesn't depend on.
      {
        code: "import { x } from '@x/cli/main';",
        filename: at('apps/launch/src/main/main.helper.ts'),
        errors: error('notInGraph'),
      },
      // The launcher taking an app by its bare name, past its listed entry files (a `main`).
      {
        code: "import * as web from '@x/web';",
        filename: at('apps/launch/src/main/main.helper.ts'),
        errors: error('appRoot'),
      },
      {
        code: "const web = await import('@x/web');",
        filename: at('apps/launch/src/main/main.helper.ts'),
        errors: error('appRoot'),
      },
      {
        code: "export * from '@x/web';",
        filename: at('apps/launch/src/main/main.helper.ts'),
        errors: error('appRoot'),
      },
      {
        code: "export { run } from '@x/web';",
        filename: at('apps/launch/src/main/main.helper.ts'),
        errors: error('appRoot'),
      },
      {
        code: 'const web = await import(`@x/web`);',
        filename: at('apps/launch/src/main/main.helper.ts'),
        errors: error('appRoot'),
      },
      // A dynamic import in backticks is checked as one in quotes.
      {
        code: 'const x = await import(`@x/web/main/main.helper`);',
        filename: at('apps/launch/src/main/main.helper.ts'),
        errors: error('notExported'),
      },
      {
        code: 'const x = await import(`@x/coding/files/files.utils`);',
        filename: CORE_FILE,
        errors: error('notInGraph'),
      },
      // The test-only package from source.
      {
        code: "import { fake } from '@x/testing/fake/fake.fake';",
        filename: CODING_FILE,
        errors: error('testOnly'),
      },
      // A relative import across workspace roots, from source and from a test.
      {
        code: "import { x } from '../../../core/src/tool/tool.utils.js';",
        filename: CODING_FILE,
        errors: error('crossesWorkspace'),
      },
      {
        code: "import { x } from '../../../../../packages/core/src/tool/tool.utils.js';",
        filename: CLI_TEST,
        errors: error('crossesWorkspace'),
      },
    ].map((test) => ({ ...test, options })),
  },
);

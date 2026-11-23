import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { HARNESS_TYPES_FILE } from '../harness-registry-types.utils.js';
import { harnessPlugin } from '../plugin.js';
import { repoRuleLinter } from '../testing/coding-rule.fake.js';
import {
  describeRuleIsOnInExtensions,
  EXTENSION_WORKSPACES as workspaces,
  messagesOfText,
  violationsInExtensions,
} from '../testing/extension-rule.fake.js';
import { typescriptRuleTester } from '../testing/rule-tester.fake.js';
import { tempWorkspace } from '../testing/workspace.fake.js';

const RULE = 'harness/extension-no-runtime-registries';
const SESSIONS = '@sheavly/runtime/sessions/sessions.service';
const TASKS = '@sheavly/runtime/tasks/tasks.service';
const APPROVALS = '@sheavly/runtime/approvals/approvals.service';
const NODES = '@sheavly/runtime/nodes/node-registry.service';
const HOST_HELPER = '@sheavly/host/host/host.helper';

const HOST_TYPES = `
import type { Provider } from '@sheavly/core/provider/provider.types';
import type { ApprovalRegistry } from '${APPROVALS}';
import type { NodeRegistry } from '${NODES}';
import type { SessionRegistry } from '${SESSIONS}';
import type { TaskRegistry } from '${TASKS}';
export type Harness = { provider: Provider; sessions: SessionRegistry; tasks: TaskRegistry; nodes: NodeRegistry; approvals: ApprovalRegistry };
`;
const root = tempWorkspace({ ...workspaces, [HARNESS_TYPES_FILE]: HOST_TYPES });
const bare = tempWorkspace(workspaces);
const withoutNodes = tempWorkspace({
  ...workspaces,
  [HARNESS_TYPES_FILE]: HOST_TYPES.replace('nodes: NodeRegistry; ', ''),
});
const options = [{ root }];
const at = (file) => path.join(root, file);
const web = at('extensions/web/src/web/web.helper.ts');
const runtime = (module) => ({ messageId: 'runtime', data: { module } });

const VALUE_USES = [
  [`import { SessionRegistry } from '${SESSIONS}';`, SESSIONS],
  [`import { TaskRegistry } from '${TASKS}';`, TASKS],
  [`import { ApprovalRegistry } from '${APPROVALS}';`, APPROVALS],
  [`import { NodeRegistry } from '${NODES}';`, NODES],
  [`export * from '${NODES}.js';`, NODES],
  [`const load = () => import('${NODES}');`, NODES],
  [
    "import { NodeRegistry } from '../../../../packages/runtime/src/nodes/node-registry.service.js';",
    NODES,
  ],
  [`import { createHarness } from '${HOST_HELPER}';`, HOST_HELPER],
  [`import { createHarness } from '${HOST_HELPER}.js';`, HOST_HELPER],
  [`import * as sessions from '${SESSIONS}';`, SESSIONS],
  [`import '${TASKS}';`, TASKS],
  [`import { type A, B } from '${TASKS}';`, TASKS],
  [`export { TaskRegistry } from '${TASKS}';`, TASKS],
  [`export { type A, B } from '${TASKS}';`, TASKS],
  [`export * from '${SESSIONS}';`, SESSIONS],
  [`export * as all from '${SESSIONS}';`, SESSIONS],
  [`const load = () => import('${APPROVALS}');`, APPROVALS],
  [`const load = () => import(\`${APPROVALS}\`);`, APPROVALS],
  [`const sessions = require('${SESSIONS}');`, SESSIONS],
  [`import sessions = require('${SESSIONS}');`, SESSIONS],
  // The same module spelled another way: a relative path into the workspace, `..` inside a
  // package specifier.
  [
    "import { TaskRegistry } from '../../../../packages/runtime/src/tasks/tasks.service.js';",
    TASKS,
  ],
  ["export * from '../../../base/src/x/../../../runtime/src/sessions/sessions.service';", SESSIONS],
  [`import { TaskRegistry } from '@sheavly/runtime/sessions/../tasks/tasks.service';`, TASKS],
  [`const load = () => import('@sheavly/runtime/./approvals/approvals.service.js');`, APPROVALS],
];
const ALLOWED = [
  `import type { SessionRegistry } from '${SESSIONS}';`,
  `import type { TaskRegistry } from '${TASKS}';`,
  `import type { NodeRegistry } from '${NODES}';`,
  `import type * as All from '${TASKS}';`,
  `import { type SessionRegistry } from '${SESSIONS}';`,
  `import { type A, type B } from '${TASKS}';`,
  `export type { TaskRegistry } from '${TASKS}';`,
  `export { type TaskRegistry } from '${TASKS}';`,
  `export type * from '${SESSIONS}';`,
  `import type { createHarness } from '${HOST_HELPER}';`,
  `import sessions = require('other');`,
  "import { startWork, finiteWork } from '@sheavly/runtime/tasks/work.utils';",
  "import type { WorkDefinition } from '@sheavly/runtime/tasks/work.types';",
  "import { WorkDefinition } from '@sheavly/runtime/tasks/work.types';",
  "import { composeInstructions } from '@sheavly/host/instructions/instructions.helper';",
  "import { a } from './local.helper.js';",
  "import { a } from '../../../../packages/runtime/src/tasks/work.utils.js';",
  "import { a } from '@sheavly/runtime/tasks/../tasks/work.utils';",
  "const other = require('node:path');",
  'const computed = (name) => import(name);',
  'const dynamic = (name) => require(name);',
];

typescriptRuleTester({ sourceType: 'module', ecmaVersion: 'latest' }).run(
  'extension-no-runtime-registries',
  harnessPlugin.rules['extension-no-runtime-registries'],
  {
    valid: [
      ...ALLOWED.map((code) => ({ code, filename: web, options })),
      // The denied modules are the ones the host's `Harness` type imports its registries from, so a
      // type that does not carry the node registry does not deny it: the rule follows the type.
      {
        code: `import { NodeRegistry } from '${NODES}';`,
        filename: path.join(withoutNodes, 'extensions/web/src/web/web.helper.ts'),
        options: [{ root: withoutNodes }],
      },
      // Test and fake files are exempt.
      ...[
        'extensions/web/src/web/__tests__/web.helper.test.ts',
        'extensions/web/src/testing/web.fake.ts',
      ].map((file) => ({
        code: `import { createHarness } from '${HOST_HELPER}';`,
        filename: at(file),
        options,
      })),
      // Only extension source is checked: a package and an app may hold the registries.
      ...['packages/base/src/b/b.helper.ts', 'apps/cli/src/m.ts'].map((file) => ({
        code: `import { createHarness } from '${HOST_HELPER}';\nimport { TaskRegistry } from '${TASKS}';`,
        filename: at(file),
        options,
      })),
    ],
    invalid: [
      ...VALUE_USES.map(([code, module]) => ({
        code,
        filename: web,
        options,
        errors: [runtime(module)],
      })),
      // The option set takes no `allow`: there is no exception to name.
      {
        code: `import { a } from '${SESSIONS}';\nexport * from '${TASKS}';`,
        filename: web,
        options,
        errors: [runtime(SESSIONS), runtime(TASKS)],
      },
      // Without a readable `Harness` type there is nothing to check against, and it says so.
      {
        code: 'export const a = 1;',
        filename: path.join(bare, 'extensions/web/src/web/web.helper.ts'),
        options: [{ root: bare }],
        errors: [{ messageId: 'unreadable', data: { file: HARNESS_TYPES_FILE } }],
      },
    ],
  },
);

describe('the rule has no exceptions, over this repo', () => {
  const eslint = repoRuleLinter(RULE);

  it('finds no violation in the source of any extension', async () => {
    expect(await violationsInExtensions({ eslint, rule: RULE })).toEqual([]);
  });

  it('fails a file shaped like a harness builder: a value import of createHarness', async () => {
    const messages = await messagesOfText({
      eslint,
      code: `import { createHarness } from '${HOST_HELPER}';\nexport const harness = createHarness({});`,
      file: 'extensions/coding/src/extension/coding.helper.ts',
    });

    expect(messages.map((message) => message.ruleId)).toEqual([RULE]);
    expect(messages[0]?.message).toContain(HOST_HELPER);
  });

  it("denies the node registry too, read from this repo's own host types, not named in the rule", async () => {
    const messages = await messagesOfText({
      eslint,
      code: `import { NodeRegistry } from '${NODES}';\nexport const nodes = new NodeRegistry();`,
      file: 'extensions/web/src/web/not-listed.helper.ts',
    });

    expect(messages.map((message) => message.ruleId)).toEqual([RULE]);
    expect(messages[0]?.message).toContain(NODES);
  });

  it("reports a registry import in any extension file, with this repo's own host types", async () => {
    const messages = await messagesOfText({
      eslint,
      code: `import { TaskRegistry } from '${TASKS}';`,
      file: 'extensions/web/src/web/not-listed.helper.ts',
    });

    expect(messages).toHaveLength(1);
    expect(messages[0]?.message).toContain(TASKS);
  });
});

describeRuleIsOnInExtensions(RULE);

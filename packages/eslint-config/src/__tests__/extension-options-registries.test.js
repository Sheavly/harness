import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { HARNESS_TYPES_FILE, readHarnessRegistries } from '../harness-registry-types.utils.js';
import { harnessPlugin } from '../plugin.js';
import {
  CORE_OUTPUT_FILE,
  RUN_SERVICES_FILE,
  readRunServiceTypes,
} from '../run-service-types.utils.js';
import { typescriptRuleTester } from '../testing/rule-tester.fake.js';
import { tempWorkspace } from '../testing/workspace.fake.js';

// The run-service keys carry scope types, so a registry type of `Harness` is no service type: the
// options rule reads those from `host.types.ts` and still refuses them in `*ExtensionOptions`.
const REPO_ROOT = path.resolve(import.meta.dirname, '../../../..');
const SERVICES = `
export const SESSION_INFO = defineService<SessionInfoView>('session-info');
export const MODEL = defineService<Provider>('model');
`;
const HOST_TYPES = `
import type { Provider } from '@sheavly/core/provider/provider.types';
import type { ApprovalRegistry } from '@sheavly/runtime/approvals/approvals.service';
import type { SessionRegistry } from '@sheavly/runtime/sessions/sessions.service';
import type { TaskRegistry } from '@sheavly/runtime/tasks/tasks.service';
export type Harness = {
  provider: Provider;
  sessions: SessionRegistry;
  tasks: TaskRegistry;
  approvals: ApprovalRegistry;
};
`;

const root = tempWorkspace({
  'package.json': { name: 'monorepo', workspaces: ['packages/*', 'extensions/*'] },
  'extensions/web/package.json': { name: '@sheavly/web', sheavly: { domain: 'generic' } },
  [RUN_SERVICES_FILE]: SERVICES,
  [HARNESS_TYPES_FILE]: HOST_TYPES,
});
const options = [{ root }];
const web = path.join(root, 'extensions/web/src/web/web.types.ts');
const alias = (body) => `export type WebExtensionOptions = { ${body} };`;
const registry = (property, type) => ({ messageId: 'registry', data: { property, type } });

typescriptRuleTester({ sourceType: 'module', ecmaVersion: 'latest' }).run(
  'extension-options-use-services: registries of Harness',
  harnessPlugin.rules['extension-options-use-services'],
  {
    valid: [
      { code: alias('name: string'), filename: web, options },
      // A choice, whatever its name.
      { code: alias('mode: Mode; summarize: (text: string) => string'), filename: web, options },
      // A registry in a test is not checked.
      {
        code: alias('sessions: SessionRegistry'),
        filename: path.join(root, 'extensions/web/src/web/__tests__/web.types.test.ts'),
        options,
      },
      // A registry type the file declares itself is not the host's.
      {
        code: `interface TaskRegistry { x: 1 }\n${alias('t: TaskRegistry')}`,
        filename: web,
        options,
      },
    ],
    invalid: [
      {
        code: alias('sessions: SessionRegistry'),
        filename: web,
        options,
        errors: [registry('sessions', 'SessionRegistry')],
      },
      {
        code: alias('tasks?: TaskRegistry'),
        filename: web,
        options,
        errors: [registry('tasks', 'TaskRegistry')],
      },
      {
        code: alias('approvals: ApprovalRegistry | undefined'),
        filename: web,
        options,
        errors: [registry('approvals', 'ApprovalRegistry')],
      },
      {
        code: 'export interface WebExtensionOptions extends TaskRegistry { a: string }',
        filename: web,
        options,
        errors: [registry('extends TaskRegistry', 'TaskRegistry')],
      },
    ],
  },
);

// A type that bundles services (`OutputStore = OutputReader & OutputCapture`) is as much run state
// as its parts: the rule reads it from the core output types, never from a list.
const OUTPUT_SERVICES = `
export const OUTPUT_READER = defineService<OutputReader>('output-reader');
export const OUTPUT_CAPTURE = defineService<OutputCapture>('output-capture');
`;
const OUTPUT_TYPES = `
export type OutputStore = OutputReader & OutputCapture;
export type Unrelated = OutputReader & Elsewhere;
export type Shaped = OutputReader & { extra: string };
`;
const outputRoot = (core) =>
  tempWorkspace({
    'package.json': { name: 'monorepo', workspaces: ['extensions/*'] },
    'extensions/web/package.json': { name: '@sheavly/web', sheavly: { domain: 'generic' } },
    [RUN_SERVICES_FILE]: OUTPUT_SERVICES,
    ...(core === undefined ? {} : { [CORE_OUTPUT_FILE]: core }),
  });
const withOutput = outputRoot(OUTPUT_TYPES);
const withoutCore = outputRoot(undefined);
const inRoot = (own) => path.join(own, 'extensions/web/src/web/web.types.ts');
const outputProblem = (property, type, key) => ({
  messageId: 'runState',
  data: { property, type, key },
});

typescriptRuleTester({ sourceType: 'module', ecmaVersion: 'latest' }).run(
  'extension-options-use-services: types that bundle services',
  harnessPlugin.rules['extension-options-use-services'],
  {
    valid: [
      // An intersection with a type that is no service is not added.
      {
        code: alias('u: Unrelated'),
        filename: inRoot(withOutput),
        options: [{ root: withOutput }],
      },
      { code: alias('s: Shaped'), filename: inRoot(withOutput), options: [{ root: withOutput }] },
      // Without the core file nothing crashes and the bundle is not known.
      {
        code: alias('store: OutputStore'),
        filename: inRoot(withoutCore),
        options: [{ root: withoutCore }],
      },
      // An unparsable core file adds nothing either.
      {
        code: alias('store: OutputStore'),
        filename: inRoot(outputRoot('export type = ;')),
        options: [{ root: outputRoot('export type = ;') }],
      },
    ],
    invalid: [
      {
        code: alias('store: OutputStore'),
        filename: inRoot(withOutput),
        options: [{ root: withOutput }],
        errors: [outputProblem('store', 'OutputStore', 'OUTPUT_READER and OUTPUT_CAPTURE')],
      },
      {
        code: alias('reader: OutputReader'),
        filename: inRoot(withOutput),
        options: [{ root: withOutput }],
        errors: [outputProblem('reader', 'OutputReader', 'OUTPUT_READER')],
      },
    ],
  },
);

describe('the bundled service types are read from the core output types', () => {
  it('maps OutputStore to both keys in this repo, and nothing extra without the core file', () => {
    expect(readRunServiceTypes(REPO_ROOT).get('OutputStore')).toBe(
      'OUTPUT_READER and OUTPUT_CAPTURE',
    );
    expect(readRunServiceTypes(withoutCore).has('OutputStore')).toBe(false);
    expect(readRunServiceTypes(withOutput).has('Unrelated')).toBe(false);
  });
});

describe('the registries are read from the Harness type, not listed', () => {
  it("finds the registries of this repo's host, each with its module, and not Provider", () => {
    const { state, registries } = readHarnessRegistries(REPO_ROOT);

    expect(state).toBe('read');
    expect(Object.fromEntries(registries)).toEqual({
      ApprovalRegistry: '@sheavly/runtime/approvals/approvals.service',
      ConversationChannels: '@sheavly/runtime/nodes/conversation-channels.service',
      NodeChannelWriter: '@sheavly/runtime/nodes/node-channel-writer.service',
      NodeRegistry: '@sheavly/runtime/nodes/node-registry.service',
      SessionRegistry: '@sheavly/runtime/sessions/sessions.service',
      SystemPrompt: '../instructions/system-prompt.service',
      TaskRegistry: '@sheavly/runtime/tasks/tasks.service',
      TreeChannelWriter: '@sheavly/runtime/nodes/tree-channel-writer.service',
    });
  });

  it('reads an interface Harness too, and treats a missing file as missing', () => {
    const own = tempWorkspace({
      [HARNESS_TYPES_FILE]: `import type { Foo } from 'x/foo.service.js';\nexport interface Harness { foo: Foo }`,
    });

    expect(Object.fromEntries(readHarnessRegistries(own).registries)).toEqual({
      Foo: 'x/foo.service',
    });
    expect(readHarnessRegistries(tempWorkspace({})).state).toBe('missing');
  });
});

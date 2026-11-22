import path from 'node:path';
import { harnessPlugin } from '../plugin.js';
import { typescriptRuleTester } from '../testing/rule-tester.fake.js';
import { tempWorkspace } from '../testing/workspace.fake.js';

const root = tempWorkspace({
  'package.json': { name: 'monorepo', workspaces: ['packages/*', 'apps/*'] },
  'packages/storage/package.json': { name: '@sheavly/storage' },
  'packages/client/package.json': { name: '@sheavly/client' },
  'apps/chat/package.json': { name: '@sheavly/chat' },
  'apps/raw/package.json': { name: '@sheavly/raw' },
  'apps/backend/package.json': { name: '@sheavly/backend' },
});
const options = [{ root }];
const at = (file) => path.join(root, file);
// A front end that uses the client, and one that talks HTTP itself with storage only.
const CHAT = at('apps/chat/src/connect/connect.helper.ts');
const RAW = at('apps/raw/src/connect/connect.helper.ts');
const READ = '@sheavly/storage/discovery-file/read-discovery-file.helper';
const FINDER =
  "import { findRunningServer } from '@sheavly/storage/server-finder/server-finder.helper';";
const VERIFY = "import { verifyServer } from '@sheavly/client/client/verify.helper';";
const find = (call) => `${FINDER}\n${VERIFY}\nvoid ${call};`;
const direct = [{ messageId: 'direct' }];
const verify = [{ messageId: 'verify' }];

typescriptRuleTester({ sourceType: 'module' }).run(
  'server-through-finder',
  harnessPlugin.rules['server-through-finder'],
  {
    valid: [
      // The finder, with the real handshake written in the call.
      { code: find('findRunningServer({ home, env, uid, verify: verifyServer })'), filename: CHAT },
      {
        code: `${FINDER}\nimport { verifyServer as verify } from '@sheavly/client/client/verify.helper';\nvoid findRunningServer({ home, verify });`,
        filename: CHAT,
      },
      {
        code: `import * as finder from '@sheavly/storage/server-finder/server-finder.helper';\n${VERIFY}\nvoid finder.findRunningServer({ verify: verifyServer });`,
        filename: CHAT,
      },
      // An optional call is a call, and a namespace's other exports are not the finder.
      { code: find('findRunningServer?.({ verify: verifyServer })'), filename: CHAT },
      {
        code: "import * as finder from '@sheavly/storage/server-finder/server-finder.helper';\nvoid finder.describeNone;",
        filename: CHAT,
      },
      // A type of the finder names its shape and runs nothing.
      { code: `${FINDER}\ntype Params = Parameters<typeof findRunningServer>[0];`, filename: CHAT },
      {
        code: "export type { FoundServer } from '@sheavly/storage/server-finder/server-finder.helper';",
        filename: CHAT,
      },
      // A type names the shape and reads nothing.
      { code: `import type { DiscoveryFile } from '${READ}';`, filename: CHAT },
      { code: `import { type DiscoveryFile } from '${READ}';`, filename: RAW },
      // The rest of storage.
      { code: "import { sheavlyHome } from '@sheavly/storage/home/home.helper';", filename: RAW },
      // The server writes and reads its own file, and storage is where these modules live.
      {
        code: `import { readDiscoveryFile } from '${READ}';`,
        filename: at('apps/backend/src/x/x.helper.ts'),
      },
      {
        code: `import { readDiscoveryFile } from '${READ}';`,
        filename: at('packages/storage/src/x/x.helper.ts'),
      },
      // Tests and fakes plant and read the file, and pass the handshake they test.
      {
        code: `import { readDiscoveryFile } from '${READ}';`,
        filename: at('apps/chat/src/connect/__tests__/connect.test.ts'),
      },
      {
        code: find('findRunningServer({ verify: vi.fn(verifyServer) })'),
        filename: at('apps/chat/src/testing/found.fake.ts'),
      },
      // A specifier whose start is computed is review's, as in every import rule.
      {
        code: 'const at = "x"; void import(`${at}/discovery-file/read-discovery-file.helper`);',
        filename: CHAT,
      },
    ].map((test) => ({ ...test, options })),
    invalid: [
      // Every workspace but the server: a client, and a front end with storage only.
      { code: `import { readDiscoveryFile } from '${READ}';`, filename: CHAT, errors: direct },
      { code: `import { readDiscoveryFile } from '${READ}';`, filename: RAW, errors: direct },
      {
        code: "import { probeServerLock } from '@sheavly/storage/server-lock/server-lock-probe.helper';",
        filename: CHAT,
        errors: direct,
      },
      {
        code: "import { serverRuntimeDirectory } from '@sheavly/storage/server-runtime/server-runtime.helper';",
        filename: RAW,
        errors: direct,
      },
      { code: `export { readDiscoveryFile } from '${READ}';`, filename: CHAT, errors: direct },
      { code: `export * from '${READ}';`, filename: CHAT, errors: direct },
      { code: `void import('${READ}');`, filename: CHAT, errors: direct },
      { code: `void import(\`${READ}\`);`, filename: CHAT, errors: direct },
      // A path that starts with a server module reaches it, whatever is computed after.
      {
        code: 'const name = "read-discovery-file.helper"; void import(`@sheavly/storage/discovery-file/${name}`);',
        filename: CHAT,
        errors: direct,
      },
      {
        code: "const name = 'x'; void import('@sheavly/storage/discovery-file/' + name);",
        filename: RAW,
        errors: direct,
      },
      // The finder with any handshake but the real one, written in the call.
      { code: find('findRunningServer({ home })'), filename: CHAT, errors: verify },
      { code: find('findRunningServer()'), filename: CHAT, errors: verify },
      {
        code: find(
          "findRunningServer({ verify: async () => ({ status: 'verified', protocolVersion: '1.0.0' }) })",
        ),
        filename: CHAT,
        errors: verify,
      },
      {
        code: find('findRunningServer({ verify: (p) => verifyServer(p) })'),
        filename: CHAT,
        errors: verify,
      },
      {
        code: find('findRunningServer({ verify: verifyServer, ...rest })'),
        filename: CHAT,
        errors: verify,
      },
      { code: find('findRunningServer(settings)'), filename: CHAT, errors: verify },
      {
        code: `${FINDER}\nconst verifyServer = async () => ({ status: 'verified' });\nvoid findRunningServer({ verify: verifyServer });`,
        filename: CHAT,
        errors: verify,
      },
      // A second `verify` or a computed key may set the handshake after the real one.
      {
        code: find('findRunningServer({ verify: verifyServer, [key]: stub })'),
        filename: CHAT,
        errors: verify,
      },
      {
        code: find("findRunningServer({ verify: verifyServer, 'verify': stub })"),
        filename: CHAT,
        errors: verify,
      },
      // A string import name is still the finder.
      {
        code: "import { 'findRunningServer' as f } from '@sheavly/storage/server-finder/server-finder.helper';\nvoid f({ verify: stub });",
        filename: CHAT,
        errors: verify,
      },
      // A split path still reaches the module.
      {
        code: "void import('@sheavly/storage/discovery-file' + '/read-discovery-file.helper');",
        filename: CHAT,
        errors: direct,
      },
      // Passed on, called another way or reached through a computed key, it could be given
      // another handshake.
      ...[
        `${FINDER}\nexport const find = findRunningServer;`,
        `${FINDER}\nexport { findRunningServer };`,
        `${FINDER}\nvoid findRunningServer.call(undefined, { verify: stub });`,
        `${FINDER}\nvoid findRunningServer.apply(undefined, [{ verify: stub }]);`,
        `${FINDER}\nvoid findRunningServer.bind(null)({ verify: stub });`,
        `${FINDER}\nvoid findRunningServer?.call(undefined, { verify: stub });`,
        "import * as finder from '@sheavly/storage/server-finder/server-finder.helper';\nvoid finder.findRunningServer.call(undefined, { verify: stub });",
        "import * as finder from '@sheavly/storage/server-finder/server-finder.helper';\nvoid finder[key]({ verify: stub });",
        "import * as finder from '@sheavly/storage/server-finder/server-finder.helper';\nexport const all = finder;",
        "export { findRunningServer } from '@sheavly/storage/server-finder/server-finder.helper';",
        "export { findRunningServer as find } from '@sheavly/storage/server-finder/server-finder.helper';",
        "export * from '@sheavly/storage/server-finder/server-finder.helper';",
      ].map((code) => ({ code, filename: CHAT, errors: [{ messageId: 'finderValue' }] })),
      // A finder reached through a computed key with its own name is still checked as a call.
      {
        code: "import * as finder from '@sheavly/storage/server-finder/server-finder.helper';\nvoid finder['findRunningServer']({ verify: stub });",
        filename: CHAT,
        errors: verify,
      },
      // Imported dynamically, its call can't be checked.
      {
        code: "const { findRunningServer: f } = await import('@sheavly/storage/server-finder/server-finder.helper');\nvoid f({ verify: stub });",
        filename: CHAT,
        errors: [{ messageId: 'finderDynamic' }],
      },
    ].map((test) => ({ ...test, options })),
  },
);

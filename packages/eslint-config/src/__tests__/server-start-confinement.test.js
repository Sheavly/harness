import { beforeAll, describe, expect, it } from 'vitest';
import { LAUNCHER_ENTRIES } from '../layout.js';
import { serverStartConfinement } from '../server-start-confinement.js';
import {
  expectRefusedIn,
  launcherReports as reported,
  warmLauncherLint,
} from '../testing/launcher-lint.fake.js';

// The program the lints run on is built once, here, so no test's limit pays for it.
beforeAll(warmLauncherLint, 180_000);

const MODULE = '@sheavly/backend/run-server/embedded-server.helper';
const START_LINES = [
  `import { startEmbeddedServer } from '${MODULE}';\nvoid startEmbeddedServer;\n`,
  `export { startEmbeddedServer } from '${MODULE}';\n`,
];
const REAL_TOOLS_LINE =
  "import { createSystemTools } from '../service/system.helper.js';\nvoid createSystemTools;\n";
const PROCESS_LINE = "import { spawn } from 'node:child_process';\nvoid spawn;\n";
// Every command but setup, and the folders of the app that are not commands: none may start one.
const COMMAND_FILES = [
  'src/chat/chat.helper.ts',
  'src/setup/setup.helper.ts',
  'src/doctor/doctor.helper.ts',
  'src/dispatch/dispatch.helper.ts',
  'src/serve/serve.helper.ts',
];
const SERVICE_FILES = ['src/service/service.helper.ts', 'src/service/install.helper.ts'];
// Where it is allowed: the entry that wires it, and tests and fakes, which may start a real one.
const ALLOWED_FILES = [
  'src/cli.ts',
  'src/setup/__tests__/setup.helper.test.ts',
  'src/service/__tests__/service.helper.test.ts',
  'src/testing/system-tools.fake.ts',
];

// A command of the launcher starts no server of its own: only `src/cli.ts` imports the module that
// starts one in the process and hands it to `sheavly setup`. A static import, a re-export and a
// dynamic `import('…')` of a string literal or a template literal without expressions are seen;
// `createRequire` and a specifier in a variable are not, and stay with review.
const DYNAMIC_LINES = [
  `void import('${MODULE}');\n`,
  `void import(\`${MODULE}\`);\n`,
  "void import('../../backend/src/run-server/embedded-server.helper.js');\n",
];
const WRAPPER = 'src/service/system.helper.ts';

describe('the launcher’s server start', () => {
  it('is listed for the launcher, and confined by three blocks that do not overlap', () => {
    const [service, rest, wrapper] = serverStartConfinement;

    expect(LAUNCHER_ENTRIES['@sheavly/backend']).toContain('run-server/embedded-server.helper');
    expect(serverStartConfinement).toHaveLength(3);
    expect(service.files).toEqual(['src/service/**/*.{ts,tsx,js,mjs}']);
    expect(service.ignores).toContain(WRAPPER);
    expect(rest.files).toEqual(['src/**/*.{ts,tsx,js,mjs}']);
    expect(rest.ignores).toContain('src/cli.ts');
    expect(rest.ignores).toContain('src/service/**');
    expect(wrapper.files).toEqual([WRAPPER]);
  });

  it.each(START_LINES)(
    'refuses %s in the wrapper of the real systemd tools, which the systemd blocks leave alone',
    (line) =>
      expectRefusedIn({ code: line, files: [WRAPPER], why: 'does not start a server of its own' }),
  );

  it.each(DYNAMIC_LINES)('refuses %s in every command and in the service folder', (line) =>
    expectRefusedIn({
      code: line,
      files: [...COMMAND_FILES, ...SERVICE_FILES, WRAPPER],
      why: 'does not start a server of its own',
      rule: 'no-restricted-syntax',
    }),
  );

  it.each(DYNAMIC_LINES)('leaves %s to cli.ts, the tests and the fakes', async (line) => {
    for (const file of ALLOWED_FILES) {
      expect(await reported({ code: line, file, rule: 'no-restricted-syntax' }), file).toHaveLength(
        0,
      );
    }
  });

  it.each(START_LINES)('refuses %s in every command and in the service folder', (line) =>
    expectRefusedIn({
      code: line,
      files: [...COMMAND_FILES, ...SERVICE_FILES],
      why: 'does not start a server of its own',
    }),
  );

  it('refuses it in the connection command too, by that command’s own, stricter list', () =>
    expectRefusedIn({
      code: START_LINES[0],
      files: ['src/connection/connection.helper.ts'],
      why: 'starts no server and no chat',
    }));

  it.each(START_LINES)('leaves %s to cli.ts, the tests and the fakes', async (line) => {
    for (const file of ALLOWED_FILES) {
      expect(await reported({ code: line, file }), file).toHaveLength(0);
    }
  });

  it('keeps refusing the real systemd tools where the systemd blocks did, which these would drop', () =>
    expectRefusedIn({
      code: REAL_TOOLS_LINE,
      files: [...COMMAND_FILES, ...SERVICE_FILES],
      why: 'src/cli.ts only',
    }));

  it('keeps refusing a process in the service folder, and still allows one in the other commands', async () => {
    for (const file of SERVICE_FILES) {
      expect(await reported({ code: PROCESS_LINE, file }), file).toHaveLength(1);
    }

    for (const file of COMMAND_FILES) {
      expect(await reported({ code: PROCESS_LINE, file }), file).toHaveLength(0);
    }
  });

  it('keeps the systemd dynamic-import rule where this block does not set it', () =>
    expectRefusedIn({
      code: "void import('../service/system.helper.js');\n",
      files: COMMAND_FILES,
      why: 'src/cli.ts only',
      rule: 'no-restricted-syntax',
    }));
});

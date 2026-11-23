import { describe, expect, it } from 'vitest';
import { launcherReports as reported } from '../testing/launcher-lint.fake.js';
import { systemdConfinement } from '../systemd-confinement.js';

const SYNTAX = 'no-restricted-syntax';
const WRAPPER = 'src/service/system.helper.ts';
const ENTRY = 'src/cli.ts';
// The service folder, tests included: a test is where a real `systemctl --user enable` would run
// by accident.
const SERVICE_FILES = [
  'src/service/install.helper.ts',
  'src/service/service.helper.ts',
  'src/service/__tests__/service.helper.test.ts',
];
// The rest of the app: another command may start a process of its own (a test starts the command
// line itself), but none may reach the real systemd tools.
const OTHER_FILES = [
  'src/setup/setup.helper.ts',
  'src/chat/__tests__/source-jsx.processes.test.ts',
  'src/testing/system-tools.fake.ts',
];
const PROCESS_LINES = [
  "import { execFile } from 'node:child_process';\nvoid execFile;\n",
  "import { spawn } from 'child_process';\nvoid spawn;\n",
  "import { exec } from 'node:child_process/foo';\nvoid exec;\n",
  "export { execSync } from 'node:child_process';\n",
];
const REAL_TOOLS_LINES = [
  "import { createSystemTools } from './system.helper.js';\nvoid createSystemTools;\n",
  "import { createSystemTools } from '../service/system.helper';\nvoid createSystemTools;\n",
  "import { createSystemTools } from './service/system.helper.js';\nvoid createSystemTools;\n",
];

// The service runs systemd's programs only behind `SystemTools`, so a test passes a fake and no
// test runs `systemctl` or `loginctl` on the machine it runs on. A static import and a dynamic
// `import('…')` of a string literal or a template literal without expressions are seen;
// `createRequire`, a specifier in a variable and a template with expressions stay with review.
describe('the launcher’s systemd programs', () => {
  it('are confined by two blocks that do not overlap, so neither loses its options', () => {
    const [service, rest] = systemdConfinement;

    expect(systemdConfinement).toHaveLength(2);
    expect(service.files).toEqual(['src/service/**/*.{ts,tsx,js,mjs}']);
    expect(service.ignores).toEqual([WRAPPER]);
    expect(rest.files).toEqual(['src/**/*.{ts,tsx,js,mjs}']);
    expect(rest.ignores).toEqual([ENTRY, 'src/service/**']);
  });

  it.each(PROCESS_LINES)(
    'refuses %s in the service folder, but not in its wrapper',
    async (line) => {
      for (const file of SERVICE_FILES) {
        const messages = await reported({ code: line, file });

        expect(messages, file).toHaveLength(1);
        expect(messages[0].message, file).toContain('system.helper.ts');
      }

      expect(await reported({ code: line, file: WRAPPER })).toHaveLength(0);
    },
  );

  it.each(PROCESS_LINES)('leaves %s to the rest of the app', async (line) => {
    for (const file of [...OTHER_FILES, ENTRY]) {
      expect(await reported({ code: line, file }), file).toHaveLength(0);
    }
  });

  it.each(REAL_TOOLS_LINES)('refuses %s anywhere but cli.ts and the wrapper', async (line) => {
    for (const file of [...SERVICE_FILES, ...OTHER_FILES]) {
      const messages = await reported({ code: line, file });

      expect(messages, file).toHaveLength(1);
      expect(messages[0].message, file).toContain('src/cli.ts only');
    }

    expect(await reported({ code: line, file: ENTRY })).toHaveLength(0);
  });

  it('lets cli.ts create the real tools and lets the wrapper start the programs', async () => {
    const real = "import { createSystemTools } from './service/system.helper.js';\n";
    const spawn = "import { execFile } from 'node:child_process';\n";

    expect(await reported({ code: real, file: ENTRY })).toHaveLength(0);
    expect(await reported({ code: spawn, file: WRAPPER })).toHaveLength(0);
  });

  it.each([
    ["void import('node:child_process');", 'child_process', 'dynamic'],
    ['void import("child_process");', 'child_process', 'dynamic'],
    ['void import(`node:child_process`);', 'child_process', 'template'],
  ])('reports %s (%s, %s literal) in the service folder only', async (line) => {
    for (const file of SERVICE_FILES) {
      expect(await reported({ code: `${line}\n`, file, rule: SYNTAX }), file).toHaveLength(1);
    }

    for (const file of [...OTHER_FILES, ENTRY, WRAPPER]) {
      expect(await reported({ code: `${line}\n`, file, rule: SYNTAX }), file).toHaveLength(0);
    }
  });

  it.each([
    ["void import('./system.helper.js');", 'dynamic'],
    ['void import(`../service/system.helper`);', 'template'],
  ])('reports %s (%s literal) anywhere but cli.ts and the wrapper', async (line) => {
    for (const file of [...SERVICE_FILES, ...OTHER_FILES]) {
      expect(await reported({ code: `${line}\n`, file, rule: SYNTAX }), file).toHaveLength(1);
    }

    for (const file of [ENTRY, WRAPPER]) {
      expect(await reported({ code: `${line}\n`, file, rule: SYNTAX }), file).toHaveLength(0);
    }
  });

  it('does not see a template literal with an expression, which stays with review', async () => {
    const code = 'const part = "child";\nvoid import(`node:${part}_process`);\n';

    expect(await reported({ code, file: SERVICE_FILES[0], rule: SYNTAX })).toHaveLength(0);
  });

  it('does not report an import of something else', async () => {
    const code = "import { readFile } from 'node:fs/promises';\nvoid readFile;\n";

    for (const file of [...SERVICE_FILES, ...OTHER_FILES, ENTRY, WRAPPER]) {
      expect(await reported({ code, file }), file).toHaveLength(0);
    }
  });
});

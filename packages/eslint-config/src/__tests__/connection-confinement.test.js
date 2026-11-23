import { describe, expect, it } from 'vitest';
import { connectionConfinement } from '../connection-confinement.js';
import { launcherReports as reported } from '../testing/launcher-lint.fake.js';

const GLOBALS = 'no-restricted-globals';
const PROPERTIES = 'no-restricted-properties';
// The connection command's own files, which are confined.
const CONFINED = [
  'src/connection/connection.helper.ts',
  'src/connection/connection.utils.ts',
  'src/connection/connection.types.ts',
];
// Its tests start the real command line and servers on purpose.
const EXEMPT = ['src/connection/__tests__/connection.helper.test.ts'];
// The rest of the app, which is not: `chat` talks to a server, `serve` starts one.
const OTHER_FILES = [
  'src/chat/find-server.helper.ts',
  'src/chat/chat.helper.ts',
  'src/setup/setup.helper.ts',
];
const START_LINES = [
  "import { runServer } from '@sheavly/backend/run-server/run-server.helper';\nvoid runServer;\n",
  "import { runTerminalChat } from '@sheavly/terminal/chat/start.helper';\nvoid runTerminalChat;\n",
  "export { runServer } from '@sheavly/backend/run-server/run-server.helper';\n",
];
const CONTACT_LINES = [
  "import { verifyServer } from '@sheavly/client/client/verify.helper';\nvoid verifyServer;\n",
  "import { createServer } from 'node:http';\nvoid createServer;\n",
  "import net from 'net';\nvoid net;\n",
  "import { connect } from 'node:tls/promises';\nvoid connect;\n",
  "import { spawn } from 'node:child_process';\nvoid spawn;\n",
  "import { fetch } from 'undici';\nvoid fetch;\n",
];
const ESCAPE_LINES = [
  "import process from 'node:process';\nvoid process;\n",
  "import { stdout } from 'node:process';\nvoid stdout;\n",
  "import { log } from 'node:console';\nvoid log;\n",
  "import { createRequire } from 'node:module';\nvoid createRequire;\n",
  "import vm from 'vm';\nvoid vm;\n",
  "import { ProcessRunner } from '@sheavly/process/runner/process-runner.service';\nvoid ProcessRunner;\n",
];
const REAL_TOOLS_LINE =
  "import { createSystemTools } from '../service/system.helper.js';\nvoid createSystemTools;\n";
const GLOBAL_LINES = [
  ['void fetch;\n', 'contacts no server itself'],
  ['void new WebSocket("ws://x");\n', 'contacts no server itself'],
  ['console.log("x");\n', 'writes only through its `streams`'],
];
const PROPERTY_LINES = [
  'process.stdout.write("x");\n',
  'process.stderr.write("x");\n',
  'process.getBuiltinModule("node:net");\n',
];

// `sheavly connection` prints a server's token, so its folder starts no server, contacts none and
// writes only through its streams; the finder and the handshake are in the lookup `cli.ts` passes
// in. A static import (and a re-export) is seen, and a global: `createRequire`, a dynamic
// `import('…')` of anything but the real systemd tools, `globalThis.fetch` and a token put in a
// message or given to `streams.err` are not, and stay with review.
describe('the launcher’s connection command', () => {
  it('is confined in its own folder, and not in its tests', () => {
    expect(connectionConfinement.files).toEqual(['src/connection/**/*.{ts,tsx,js,mjs}']);
    expect(connectionConfinement.ignores).toEqual([
      'src/connection/**/__tests__/**',
      'src/connection/testing/**',
    ]);
  });

  it.each([
    ...START_LINES.map((line) => [line, 'starts no server and no chat']),
    ...CONTACT_LINES.map((line) => [line, 'contacts no server itself']),
    ...ESCAPE_LINES.map((line) => [line, 'loads nothing around its imports']),
  ])('refuses %s: the command %s', async (line, why) => {
    for (const file of CONFINED) {
      const messages = await reported({ code: line, file });

      expect(messages, file).toHaveLength(1);
      expect(messages[0].message, file).toContain(why);
    }
  });

  it('still refuses the real systemd tools in its folder, which the later rule would otherwise drop', async () => {
    for (const file of CONFINED) {
      const messages = await reported({ code: REAL_TOOLS_LINE, file });

      expect(messages, file).toHaveLength(1);
      expect(messages[0].message, file).toContain('src/cli.ts only');
    }
  });

  it('still refuses a dynamic import of the real systemd tools in its folder: the other rule the systemd block sets applies there too', async () => {
    const code = "void import('../service/system.helper.js');\n";

    for (const file of CONFINED) {
      const messages = await reported({ code, file, rule: 'no-restricted-syntax' });

      expect(messages, file).toHaveLength(1);
      expect(messages[0].message, file).toContain('src/cli.ts only');
    }
  });

  it.each(GLOBAL_LINES)('refuses %s', async (line, why) => {
    for (const file of CONFINED) {
      const messages = await reported({ code: line, file, rule: GLOBALS });

      expect(messages, file).toHaveLength(1);
      expect(messages[0].message, file).toContain(why);
    }
  });

  it.each(PROPERTY_LINES)('refuses %s: it writes only through its streams', async (line) => {
    for (const file of CONFINED) {
      const messages = await reported({ code: line, file, rule: PROPERTIES });

      expect(messages, file).toHaveLength(1);
      expect(messages[0].message, file).toContain('writes only through its `streams`');
    }
  });

  it('leaves its tests and the rest of the app alone', async () => {
    const everything = [...START_LINES, ...CONTACT_LINES, ...ESCAPE_LINES];

    for (const line of everything) {
      for (const file of [...EXEMPT, ...OTHER_FILES]) {
        expect(await reported({ code: line, file }), `${file}: ${line}`).toHaveLength(0);
      }
    }

    for (const [line] of GLOBAL_LINES) {
      for (const file of [...EXEMPT, ...OTHER_FILES]) {
        expect(await reported({ code: line, file, rule: GLOBALS }), file).toHaveLength(0);
      }
    }

    for (const line of PROPERTY_LINES) {
      for (const file of [...EXEMPT, ...OTHER_FILES]) {
        expect(await reported({ code: line, file, rule: PROPERTIES }), file).toHaveLength(0);
      }
    }
  });

  it('still refuses the real systemd tools in the rest of the app, as before', async () => {
    for (const file of OTHER_FILES) {
      const messages = await reported({ code: REAL_TOOLS_LINE, file });

      expect(messages, file).toHaveLength(1);
    }
  });

  it('lets its folder import what it needs: the types of the lookup and its own errors', async () => {
    const code =
      "import type { VerifiedServer } from '../chat/chat.types.js';\nimport { UsageError } from '../errors/cli.errors.js';\nvoid UsageError;\nexport type { VerifiedServer };\n";

    for (const file of CONFINED) {
      expect(await reported({ code, file }), file).toHaveLength(0);
    }
  });
});

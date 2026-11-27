import path from 'node:path';
import { ESLint, Linter } from 'eslint';
import { beforeAll, describe, expect, it } from 'vitest';
import { replayConfinement } from '../replay-confinement.js';
import { sourceFilesUnder } from '../testing/source-files.fake.js';

const TERMINAL = path.resolve(import.meta.dirname, '../../../../apps/terminal');
const CONFINED_RULES = [
  'no-restricted-imports',
  'no-restricted-globals',
  'no-restricted-properties',
  'no-restricted-syntax',
];
const eslint = new ESLint({ cwd: TERMINAL });

// The first lint builds the terminal's typed program, with every source it imports: most of this
// file's time, so it is built once here and counts against no test's limit.
beforeAll(() => eslint.lintText('', { filePath: path.join(TERMINAL, 'src/chat.ts') }), 180_000);

/** The ids of the rules `code` breaks, linted with `replayConfinement`'s rules. */
function broken(code) {
  const messages = new Linter().verify(
    code,
    [
      {
        files: ['**/*.js'],
        languageOptions: {
          sourceType: 'module',
          ecmaVersion: 'latest',
          // Declared, so `no-restricted-globals` sees them as the globals they are.
          globals: { fetch: 'readonly', WebSocket: 'readonly', Worker: 'readonly' },
        },
        rules: replayConfinement.rules,
      },
    ],
    'replay.js',
  );

  return messages.map((message) => message.ruleId);
}

/** Whether `rule` is an error for `file` of the terminal app. */
async function isErrorFor(params) {
  const { rule, file } = params;
  const config = await eslint.calculateConfigForFile(path.join(TERMINAL, file));
  const entry = config?.rules[rule];

  return (Array.isArray(entry) ? entry[0] : entry) === 2;
}

/** Every source file of replay, read from the folder so a new one is covered without an edit. */
const replaySources = [
  'src/replay.ts',
  ...sourceFilesUnder({ root: TERMINAL, folder: 'src/replay' }),
];

const IMPORTS = 'no-restricted-imports';
const GLOBALS = 'no-restricted-globals';
const PROPERTIES = 'no-restricted-properties';
const SYNTAX = 'no-restricted-syntax';

// Replay's promise (no backend, model, network or process) is only as good as these answers: a
// renamed folder or a widened override changes them. What a name in a variable reaches, and what
// the workbook store replay resolves runs with imports itself, stay with review.
describe('replay in the terminal app', () => {
  it('sets every confinement rule to error, for replay files and not its tests', () => {
    for (const rule of CONFINED_RULES) {
      expect(replayConfinement.rules[rule][0], rule).toBe('error');
    }

    expect(replayConfinement.files).toEqual(['src/replay/**/*.{ts,tsx,js,mjs}', 'src/replay.ts']);
    expect(replayConfinement.ignores).toEqual(
      expect.arrayContaining(['src/replay/**/__tests__/**', 'src/replay/testing/**']),
    );
  });

  it.each([
    ["import net from 'node:net';", IMPORTS],
    ["import { request } from 'https';", IMPORTS],
    ["import { spawn } from 'child_process';", IMPORTS],
    ["import { Worker } from 'node:worker_threads';", IMPORTS],
    ["import { createRequire } from 'node:module';", IMPORTS],
    ["import { fetch } from 'undici';", IMPORTS],
    ["import { lookup } from 'dns/promises';", IMPORTS],
    ["import { lookup } from 'node:dns/promises';", IMPORTS],
    ["import { connectBackend } from '../client';", IMPORTS],
    ["import { connectBackend } from '../client/backend.helper.js';", IMPORTS],
    ["import { connectBackend } from './client/backend.helper.js';", IMPORTS],
    ["import { connectBackend } from '../../client/backend.helper.js';", IMPORTS],
    [
      "import { RemoteConversation } from '@sheavly/client/conversation/conversation.service';",
      IMPORTS,
    ],
    ["import { createProvider } from '@sheavly/providers/registry/registry.service';", IMPORTS],
    ["import { runLoop } from '@sheavly/loop/stream-agent/stream-agent.helper';", IMPORTS],
    ["import { serve } from '@sheavly/host/host/host.helper';", IMPORTS],
    ["const net = await import('node:net');", SYNTAX],
    ["const http = require('http');", SYNTAX],
    ["const load = require; load('net');", SYNTAX],
    ['fetch(url);', GLOBALS],
    ['new WebSocket(url);', GLOBALS],
    ['new Worker(file);', GLOBALS],
    ['globalThis.fetch(url);', PROPERTIES],
    ["globalThis['fetch'](url);", PROPERTIES],
    ['self.fetch(url);', PROPERTIES],
    ['window.WebSocket;', PROPERTIES],
    ['global.fetch(url);', PROPERTIES],
    ["process.binding('tcp_wrap');", PROPERTIES],
    ["process.getBuiltinModule('node:net');", PROPERTIES],
    ['navigator.sendBeacon(url);', PROPERTIES],
  ])('refuses %s, by %s', (code, rule) => {
    expect(broken(code)).toContain(rule);
  });

  it.each([
    "import { readFile, stat } from 'node:fs/promises';",
    "import path from 'node:path';",
    "import { Writable } from 'node:stream';",
    "import { Renderer } from '../render/render.service.js';",
    "import { WorkbookStore } from '../workbook/store.service.js';",
    "process.stderr.write('x'); process.exitCode = 1; process.argv.slice(2);",
    'const options = { require: true }; options.require;',
  ])('lets replay do %s', (code) => {
    expect(broken(code)).toEqual([]);
  });

  it('applies to every replay source file, in every subfolder, and to the entry point', async () => {
    expect(replaySources.length).toBeGreaterThan(5);

    for (const file of replaySources) {
      for (const rule of CONFINED_RULES) {
        expect(await isErrorFor({ rule, file }), `${rule} on ${file}`).toBe(true);
      }
    }
  });

  it('keeps the client pattern in what the terminal app resolves, whatever blocks come after', async () => {
    const config = await eslint.calculateConfigForFile(
      path.join(TERMINAL, 'src/replay/replay.helper.ts'),
    );
    const groups = config.rules[IMPORTS][1].patterns.flatMap((pattern) => pattern.group);

    expect(groups).toEqual(expect.arrayContaining(['**/client/**', 'node:net', 'undici']));
  });

  it('leaves its tests free to stub fetch, and the rest of the app alone', async () => {
    for (const file of [
      'src/replay/__tests__/replay.helper.test.ts',
      'src/replay/testing/stream.fake.ts',
      'src/render/render.service.ts',
      'src/demo.ts',
    ]) {
      for (const rule of CONFINED_RULES) {
        expect(await isErrorFor({ rule, file }), `${rule} on ${file}`).toBe(false);
      }
    }
  });
});

// `sheavly connection` prints the token of a server it did not start, for another program to read,
// so it is held to doing that and nothing else. It finds the server through a lookup passed in by
// `src/cli.ts` (`findServer`, which is where the finder and the handshake are), so its folder
// (`src/connection/`, tests and fakes excepted) cannot start a server or a chat (the backend and
// the terminal), talk to one (the client, a network module, a global that opens a connection) or
// start a process, and it writes only through the streams it is given, never `console` or
// `process.stdout`. Importing the discovery file, the lock or the runtime folder is refused by
// `harness/server-through-finder`, not here. A static import and a re-export are seen, and the
// globals; `createRequire`, a dynamic `import('…')` and `globalThis.fetch` are not.
// The launcher app spreads `connectionConfinement` into its config; its files are relative to that app.
import { REAL_TOOLS_RESTRICTION } from './systemd-confinement.js';

/** Built-ins that reach the network or start a process, with the `node:` prefix or without. */
const REFUSED_BUILTINS = [
  'net',
  'tls',
  'dns',
  'dgram',
  'http',
  'http2',
  'https',
  'child_process',
  'cluster',
  'worker_threads',
].flatMap((name) => [name, `${name}/*`, `node:${name}`, `node:${name}/*`]);

const START_MESSAGE =
  'The connection command starts no server and no chat: it prints what the injected `findServer` found. Starting one is the wiring of src/cli.ts.';
const CONTACT_MESSAGE =
  'The connection command contacts no server itself: the finder and the handshake are in the injected `findServer` (src/chat/find-server.helper.ts), and an address given by environment is printed as given, never contacted.';
const OUTPUT_MESSAGE =
  'The connection command writes only through its `streams`: the token goes to `streams.out` in one line, and nothing else it prints may hold it.';

const ESCAPE_MESSAGE =
  'The connection command writes only through its `streams` and loads nothing around its imports: no `process`, `console`, `module`, `vm` or `inspector`, and not the process runner.';

/** Built-ins that write to a stream or load code around the imports lint reads. */
const ESCAPE_BUILTINS = ['process', 'console', 'module', 'vm', 'inspector'].flatMap((name) => [
  name,
  `node:${name}`,
]);

const GLOBALS_THAT_CONNECT = ['fetch', 'WebSocket', 'XMLHttpRequest', 'EventSource'];

export const connectionConfinement = {
  files: ['src/connection/**/*.{ts,tsx,js,mjs}'],
  // Its tests start the real command line and servers on purpose.
  ignores: ['src/connection/**/__tests__/**', 'src/connection/testing/**'],
  rules: {
    // Set once, with the real-tools restriction of `systemdConfinement` repeated: the later options
    // of a rule replace the earlier ones for the same file.
    'no-restricted-imports': [
      'error',
      {
        patterns: [
          {
            group: [
              '@sheavly/backend',
              '@sheavly/backend/*',
              '@sheavly/terminal',
              '@sheavly/terminal/*',
            ],
            message: START_MESSAGE,
          },
          {
            group: ['@sheavly/client', '@sheavly/client/*', 'undici', ...REFUSED_BUILTINS],
            message: CONTACT_MESSAGE,
          },
          {
            group: [...ESCAPE_BUILTINS, '@sheavly/process', '@sheavly/process/*'],
            message: ESCAPE_MESSAGE,
          },
          REAL_TOOLS_RESTRICTION,
        ],
      },
    ],
    'no-restricted-globals': [
      'error',
      ...GLOBALS_THAT_CONNECT.map((name) => ({ name, message: CONTACT_MESSAGE })),
      { name: 'console', message: OUTPUT_MESSAGE },
    ],
    'no-restricted-properties': [
      'error',
      { object: 'process', property: 'stdout', message: OUTPUT_MESSAGE },
      { object: 'process', property: 'stderr', message: OUTPUT_MESSAGE },
      { object: 'process', property: 'getBuiltinModule', message: ESCAPE_MESSAGE },
    ],
  },
};

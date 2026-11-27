// Replay reads a stored stream and nothing else: no network, no process, no backend, no model. It
// reads each stored line through the storage package's reader, which takes the forms older
// versions wrote, never through the wire's `streamEntrySchema`, which refuses them.
// An app spreads `replayConfinement` into its config; its files are relative to that app.

/** Node built-ins that reach the network or start a process or thread; replay uses none. */
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
  'vm',
  'inspector',
  // `module` and `repl` can load any of the above by a name lint never sees.
  'module',
  'repl',
  'v8',
];
/** Browser-style globals that open a connection or start a worker, which Node also has. */
const NETWORK_GLOBALS = [
  'fetch',
  'WebSocket',
  'XMLHttpRequest',
  'EventSource',
  'WebTransport',
  'Worker',
  'SharedWorker',
  'BroadcastChannel',
];
/** The ways to reach a global by object, which `no-restricted-globals` does not follow. */
const GLOBAL_OBJECTS = ['globalThis', 'global', 'self', 'window'];
/** Process APIs that load native code or other built-ins past the import patterns. */
const PROCESS_ESCAPES = ['binding', 'dlopen', 'getBuiltinModule', 'mainModule'];
const NETWORK_MESSAGE = 'Replay makes no network call.';
const STATIC_IMPORT_MESSAGE = 'Replay imports statically, so lint sees it.';

export const replayConfinement = {
  files: ['src/replay/**/*.{ts,tsx,js,mjs}', 'src/replay.ts'],
  // Its tests may stub `fetch` to prove it makes no call.
  ignores: ['src/replay/**/__tests__/**', 'src/replay/testing/**'],
  rules: {
    'no-restricted-imports': [
      'error',
      {
        paths: [
          {
            name: '@sheavly/protocol/stream/stream.validator',
            importNames: ['streamEntrySchema'],
            message:
              "Replay reads a stored stream, which older versions wrote in forms the wire's schema refuses: read each line or frame with `parseStoredStreamEntry` (`@sheavly/storage/conversation-store/stored-stream.utils`).",
          },
        ],
        patterns: [
          {
            group: [
              // With the `node:` prefix or without, and a subpath such as `dns/promises`.
              ...REFUSED_BUILTINS.flatMap((name) => [
                name,
                `${name}/*`,
                `node:${name}`,
                `node:${name}/*`,
              ]),
              'undici',
              '@sheavly/client',
              '@sheavly/client/*',
              '@sheavly/providers',
              '@sheavly/providers/*',
              '@sheavly/loop',
              '@sheavly/loop/*',
              '@sheavly/host',
              '@sheavly/host/*',
              // The terminal's own client, however the path to it is written.
              '**/client',
              '**/client/**',
            ],
            message:
              'Replay reads a stored stream and makes no network, process, backend or model call: it cannot import this.',
          },
        ],
      },
    ],
    'no-restricted-globals': [
      'error',
      ...NETWORK_GLOBALS.map((name) => ({ name, message: NETWORK_MESSAGE })),
    ],
    'no-restricted-properties': [
      'error',
      ...GLOBAL_OBJECTS.flatMap((object) =>
        NETWORK_GLOBALS.map((property) => ({ object, property, message: NETWORK_MESSAGE })),
      ),
      ...PROCESS_ESCAPES.map((property) => ({
        object: 'process',
        property,
        message: 'Replay loads nothing past its static imports.',
      })),
      { object: 'navigator', property: 'sendBeacon', message: NETWORK_MESSAGE },
    ],
    // A dynamic import or any use of `require` would get past the static import patterns above. A
    // property or object key that happens to be named `require` is not the function.
    'no-restricted-syntax': [
      'error',
      { selector: 'ImportExpression', message: STATIC_IMPORT_MESSAGE },
      {
        selector:
          "Identifier[name='require']:not(MemberExpression[computed=false] > Identifier.property, Property[computed=false] > Identifier.key)",
        message: STATIC_IMPORT_MESSAGE,
      },
    ],
  },
};

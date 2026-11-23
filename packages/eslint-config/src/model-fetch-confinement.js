// A model backend sends every call through the `fetch` it was built with (`AdapterDeps.fetch`,
// the model fetch by default), never Node's global one: the global sends a TLS ClientHello that
// spans two TCP segments on Node 22.20+, 24.5+ and 26, and gateways that read one segment (Azure
// AI Foundry) reset it. The providers workspace spreads `modelFetchConfinement` into its config.
// A local binding named `fetch` (a parameter, a destructured dep) is not the global and passes.

/** The ways to reach a global by object, which `no-restricted-globals` does not follow. */
const GLOBAL_OBJECTS = ['globalThis', 'global', 'self', 'window'];
/**
 * The other ways to open a connection: undici's own `fetch` or `request` (its default pool sends
 * OpenSSL's default groups and, in undici 8, offers HTTP/2) and Node's network modules. Only the
 * model fetch's own file imports them, a `files:` exception in the providers' eslint.config.js.
 */
const CONNECTION_MODULES = ['undici', 'http', 'https', 'http2', 'tls', 'net'].flatMap((name) => [
  name,
  `node:${name}`,
]);
const MESSAGE =
  "Send a model call through the injected `deps.fetch` (`AdapterDeps`), never Node's global `fetch`: by default it is `createModelFetch()`, whose TLS ClientHello fits in one TCP segment, and a test passes a fake. See 'The model fetch' in packages/providers/docs/backends.md.";

export const modelFetchConfinement = {
  files: ['src/**/*.ts'],
  // Tests and fakes build their own fetch, or stub the global one on purpose.
  ignores: ['src/**/__tests__/**', 'src/testing/**'],
  rules: {
    'no-restricted-globals': ['error', { name: 'fetch', message: MESSAGE }],
    'no-restricted-properties': [
      'error',
      ...GLOBAL_OBJECTS.map((object) => ({ object, property: 'fetch', message: MESSAGE })),
    ],
    // Exact names, not patterns: a pattern `http` would also match `../http/request.helper.js`.
    'no-restricted-imports': [
      'error',
      {
        paths: CONNECTION_MODULES.map((name) => ({ name, message: MESSAGE })),
        patterns: [{ group: ['undici/*'], message: MESSAGE }],
      },
    ],
  },
};

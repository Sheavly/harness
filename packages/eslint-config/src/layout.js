// The parts of the workspace layout that code can't tell, written here on purpose: what isn't
// source, and what the launcher may take from the apps. Everything else is read from the workspaces themselves (`layout.utils.js`, `readLayout`):
//
//   which workspaces   the root package.json `workspaces`
//   kind               the folder: `packages/*` is a package, `apps/*` an app
//   dependsOn          each workspace's own package.json `dependencies` on other workspaces
//                      (`devDependencies` for its tests)
//   domain, testOnly   each workspace's package.json `sheavly` field, set with
//                      `npm pkg set sheavly.domain=<generic|coding|tooling> -w <dir>` (and
//                      `sheavly.testOnly=true --json` for a test-only one); the scaffold sets it
//
// So a new workspace is covered by being created; nothing here needs an edit for it.

/**
 * TypeScript outside every workspace's `src/` that isn't harness source, each with why: a reviewed
 * exception, never derived. Anything else there fails the layout check (`scripts/check-layout.mjs`).
 */
export const NOT_SOURCE = {
  '*.config.ts': 'root tool configs (Vitest), loaded by the tool, not part of any workspace',
  'workbook/workspaces/**': 'the projects the workbook agent reads and writes, not harness source',
};

/**
 * The apps the launcher (`apps/sheavly`) may depend on, and the only files each may export to it
 * (`<module>/<file>.<kind>`): a reviewed exception, never derived, so a new edge or a new export of
 * an app (its backend spawn, say) is an edit here. Fakes are for the launcher's tests.
 */
export const LAUNCHER_ENTRIES = {
  '@sheavly/backend': [
    'run-server/run-server.helper',
    'testing/handshake-only.fake',
    'testing/held-server.fake',
    'testing/recording-server.fake',
    'testing/recording-server.types',
    'testing/serve-process.fake',
    'testing/serve-process.types',
  ],
  '@sheavly/terminal': ['chat/start.helper', 'chat/chat-failure.helper', 'setup/run-setup.helper'],
};

// A command of the launcher starts no server of its own. `sheavly setup` may run on a short-lived
// one when none is running, but it is handed the function that starts it (`startServer` of
// `@sheavly/backend/run-server/embedded-server.helper`), and only `src/cli.ts` imports that
// module: `chat`, `connection`, `doctor`, `service` and every other command have no way to start
// a server of this kind (`runServer`, which `serve` uses, is a different entry and stays as it
// was), and a test passes a fake instead of the real one. A static import, a re-export and a
// dynamic `import('…')` of a string literal or a template literal without expressions are seen;
// `createRequire` and a specifier in a variable are not, and stay with review. Tests and fakes are
// excepted: a process test may start a real server on purpose.
// The launcher app spreads `serverStartConfinement` into its config, after `systemdConfinement`
// and before `connectionConfinement`; its files are relative to that app.
import {
  PROCESS_DYNAMIC_IMPORTS,
  PROCESS_RESTRICTION,
  REAL_TOOLS_DYNAMIC_IMPORTS,
  REAL_TOOLS_RESTRICTION,
  dynamicImports,
} from './systemd-confinement.js';

const START_MESSAGE =
  'A command does not start a server of its own: src/cli.ts imports the embedded server and hands it to the one command that may use it (setup). Take it as a dependency, and let a test pass a fake.';

/** The import restriction on the module that starts a server in this process. */
const START_RESTRICTION = {
  group: ['@sheavly/backend/run-server/embedded-server.helper'],
  message: START_MESSAGE,
};

/** `import('…')` of that module, a string literal or a template literal without expressions. */
const START_DYNAMIC_IMPORTS = dynamicImports({
  specifier: '/(^|\\/)embedded-server\\.helper(\\.js)?$/',
  message: START_MESSAGE,
});

const EXTENSIONS = '{ts,tsx,js,mjs}';
const WRAPPER = 'src/service/system.helper.ts';
const TEST_FILES = ['src/**/__tests__/**', 'src/testing/**'];

/**
 * Three blocks that never overlap, mirroring `systemdConfinement`: a rule set twice for one file
 * keeps only the later options, so each repeats what the systemd block it sits over refuses, for
 * both rules it sets. The service folder (the wrapper excepted) also refuses a process and the
 * real tools; the rest of the app, `cli.ts` and tests excepted, the real tools. The wrapper, which
 * the systemd blocks leave alone because it starts the real programs, is refused only the server.
 */
export const serverStartConfinement = [
  {
    files: [`src/service/**/*.${EXTENSIONS}`],
    ignores: [WRAPPER, ...TEST_FILES],
    rules: {
      'no-restricted-imports': [
        'error',
        { patterns: [PROCESS_RESTRICTION, REAL_TOOLS_RESTRICTION, START_RESTRICTION] },
      ],
      'no-restricted-syntax': [
        'error',
        ...PROCESS_DYNAMIC_IMPORTS,
        ...REAL_TOOLS_DYNAMIC_IMPORTS,
        ...START_DYNAMIC_IMPORTS,
      ],
    },
  },
  {
    files: [`src/**/*.${EXTENSIONS}`],
    ignores: ['src/cli.ts', 'src/service/**', ...TEST_FILES],
    rules: {
      'no-restricted-imports': ['error', { patterns: [REAL_TOOLS_RESTRICTION, START_RESTRICTION] }],
      'no-restricted-syntax': ['error', ...REAL_TOOLS_DYNAMIC_IMPORTS, ...START_DYNAMIC_IMPORTS],
    },
  },
  {
    files: [WRAPPER],
    rules: {
      'no-restricted-imports': ['error', { patterns: [START_RESTRICTION] }],
      'no-restricted-syntax': ['error', ...START_DYNAMIC_IMPORTS],
    },
  },
];

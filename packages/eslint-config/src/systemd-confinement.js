// The launcher runs systemd's programs (`systemctl`, `loginctl`, `journalctl`) for `sheavly
// service`, and only through `SystemTools`: an argument array, never a shell line, in one file
// (`src/service/system.helper.ts`), which only `src/cli.ts` creates. The service folder starts no
// process of its own. A test passes the fake from `src/testing/system-tools.fake.ts`, so a test
// cannot get the real tools by importing them. That is not a guarantee that no test runs a real
// `systemctl`: a process test that starts the command line itself reaches the real systemd for an
// action that gets as far as asking it, which stays with review.
// The launcher app spreads `systemdConfinement` into its config; its files are relative to that app.

const PROCESS_MESSAGE =
  'Programs are started only in src/service/system.helper.ts, by name with an argument array and no shell, behind SystemTools: a command of the service never builds a shell line. Use the injected `system` of the service deps.';
const REAL_TOOLS_MESSAGE =
  'The real systemd tools are created in src/cli.ts only. A command takes `system: SystemTools` as a dependency, and a test passes the fake from src/testing/system-tools.fake.ts, so no test runs systemctl or loginctl on the machine it runs on.';

/** The built-in that starts a process, with the `node:` prefix or without, and a subpath. */
const PROCESS_MODULES = ['child_process', 'node:child_process'].flatMap((name) => [
  name,
  `${name}/*`,
]);

/**
 * The import restriction on starting a process, for a folder that sets `no-restricted-imports` of
 * its own on top of the service folder's: it must repeat this one (see below).
 */
export const PROCESS_RESTRICTION = { group: PROCESS_MODULES, message: PROCESS_MESSAGE };

/** The one file that wraps the real programs, however it is written in an import. */
const REAL_TOOLS = ['**/system.helper', '**/system.helper.js'];

/**
 * The import restriction on the real tools, for a folder that sets `no-restricted-imports` of its
 * own: a rule set twice for one file keeps only the later options, so it must repeat this one.
 */
export const REAL_TOOLS_RESTRICTION = { group: REAL_TOOLS, message: REAL_TOOLS_MESSAGE };

// `no-restricted-imports` does not see `import('…')` with a string literal or a template literal
// without expressions; these selectors do. A specifier in a variable, or with an expression in a
// template, and `createRequire` stay with review.
const PROCESS_SPECIFIER = '/^(node:)?child_process(\\/.*)?$/';
const REAL_TOOLS_SPECIFIER = '/(^|\\/)system\\.helper(\\.js)?$/';

/** The `no-restricted-syntax` selectors for a dynamic import of `specifier`, literal or template. */
export function dynamicImports(params) {
  const { specifier, message } = params;

  return [
    { selector: `ImportExpression[source.type='Literal'][source.value=${specifier}]`, message },
    {
      selector: `ImportExpression[source.type='TemplateLiteral'][source.expressions.length=0][source.quasis.0.value.cooked=${specifier}]`,
      message,
    },
  ];
}

/**
 * The dynamic-import selectors for a process and for the real tools, for a block that sets
 * `no-restricted-syntax` of its own over the same files: a rule set twice keeps only the later
 * options, so it must repeat these.
 */
export const PROCESS_DYNAMIC_IMPORTS = dynamicImports({
  specifier: PROCESS_SPECIFIER,
  message: PROCESS_MESSAGE,
});
export const REAL_TOOLS_DYNAMIC_IMPORTS = dynamicImports({
  specifier: REAL_TOOLS_SPECIFIER,
  message: REAL_TOOLS_MESSAGE,
});

const EXTENSIONS = '{ts,tsx,js,mjs}';

/**
 * Two blocks that never overlap, because a rule set twice for one file keeps only the later
 * options. In the service folder (the wrapper itself excepted) neither a process nor the real
 * tools may be imported. Everywhere else in the app only the real tools are refused, and `cli.ts`,
 * which creates them, is excepted: another command may start a process of its own (a test starts
 * the command line itself), but none may reach the real systemd tools.
 */
export const systemdConfinement = [
  {
    files: [`src/service/**/*.${EXTENSIONS}`],
    ignores: ['src/service/system.helper.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            { group: PROCESS_MODULES, message: PROCESS_MESSAGE },
            { group: REAL_TOOLS, message: REAL_TOOLS_MESSAGE },
          ],
        },
      ],
      'no-restricted-syntax': ['error', ...PROCESS_DYNAMIC_IMPORTS, ...REAL_TOOLS_DYNAMIC_IMPORTS],
    },
  },
  {
    files: [`src/**/*.${EXTENSIONS}`],
    ignores: ['src/cli.ts', 'src/service/**'],
    rules: {
      'no-restricted-imports': [
        'error',
        { patterns: [{ group: REAL_TOOLS, message: REAL_TOOLS_MESSAGE }] },
      ],
      'no-restricted-syntax': ['error', ...REAL_TOOLS_DYNAMIC_IMPORTS],
    },
  },
];

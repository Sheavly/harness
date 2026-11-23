import { ServiceError } from '../errors/cli.errors.js';

/** `value` with backslashes and quotes escaped and `%` doubled, which every directive expands. */
function escapeForUnit(value: string): string {
  if (/[\n\r\0]/.test(value)) {
    throw new ServiceError(
      'A path or setting has a line break in it, which a unit file cannot hold.',
    );
  }

  return value
    .replaceAll('\\', '\\\\')
    .replaceAll('"', String.raw`\"`)
    .replaceAll('%', '%%');
}

/**
 * `value` as one double-quoted word of a unit file, for a directive that expands specifiers
 * (`%h`) and nothing else, as `Environment=` does. Throws a `ServiceError` for a line break or a
 * NUL, which no quoting makes safe.
 */
export function quoteForUnit(value: string): string {
  return `"${escapeForUnit(value)}"`;
}

/**
 * `value` as one word of `ExecStart=`, which also expands `$` variables, so `$` is doubled there
 * and only there: in `Environment=` a doubled `$` would stay doubled.
 */
export function quoteForExec(value: string): string {
  return `"${escapeForUnit(value).replaceAll('$', '$$$$')}"`;
}

/**
 * The text of the service's unit file. It takes no token, so it cannot hold one: the server gets
 * `SERVER_TOKEN` from `envFile`, a file only the user can read. `nodePath` and `cliPath` are the
 * built command's absolute paths, `home` and `path` the `SHEAVLY_HOME` and `PATH` the unit
 * sets so the server and the commands an agent runs find what the installing shell did.
 * `envFile` goes in as given, so the caller checks it is a plain path.
 */
export function renderUnit(params: {
  nodePath: string;
  cliPath: string;
  home: string;
  path: string;
  envFile: string;
}): string {
  const { nodePath, cliPath, home, path, envFile } = params;

  return [
    '[Unit]',
    'Description=Sheavly server',
    // A server that cannot start (another one holds the home's lock, a wrong setting) exits 1
    // and would be retried for ever: five failures in five minutes stop it.
    'StartLimitIntervalSec=300',
    'StartLimitBurst=5',
    '',
    '[Service]',
    'Type=simple',
    `ExecStart=${quoteForExec(nodePath)} ${quoteForExec(cliPath)} serve`,
    'WorkingDirectory=%h',
    `EnvironmentFile=${envFile}`,
    `Environment=${quoteForUnit(`SHEAVLY_HOME=${home}`)}`,
    `Environment=${quoteForUnit(`PATH=${path}`)}`,
    'Restart=on-failure',
    'RestartSec=5',
    '',
    '[Install]',
    'WantedBy=default.target',
    '',
  ].join('\n');
}

import path from 'node:path';
import { TOKEN_FILE_NAME, TOKEN_LINE, TOKEN_VARIABLE, UNIT_NAME } from './service.constants.js';
import type { ServiceFiles } from './service.types.js';

/**
 * Where the service's files are: the unit in the user's systemd folder
 * (`$XDG_CONFIG_HOME/systemd/user`, else `~/.config/systemd/user`), and the token file in the
 * Sheavly home, beside the user's data. The home is made absolute here, once: the unit is read by
 * systemd from another folder, which needs an absolute `EnvironmentFile=` and a `SHEAVLY_HOME`
 * that means the same folder to the server.
 */
export function serviceFiles(params: {
  env: NodeJS.ProcessEnv;
  homeDir: string;
  sheavlyHome: string;
}): ServiceFiles {
  const { env, homeDir, sheavlyHome } = params;
  const set = env.XDG_CONFIG_HOME;
  // An empty variable counts as not set, as a blank line in a shell profile leaves it.
  const config = set === undefined || set === '' ? path.join(homeDir, '.config') : set;
  const home = path.resolve(sheavlyHome);

  return {
    home,
    unit: path.join(config, 'systemd', 'user', UNIT_NAME),
    tokenFile: path.join(home, TOKEN_FILE_NAME),
  };
}

/**
 * What is wrong with a `PATH` that is about to be written into an always-on server's unit, or
 * `undefined` when it is fine: empty, or with an empty or relative entry, which would put the
 * folder the server or an agent's command happens to run in on the search path.
 */
export function pathProblem(value: string): string | undefined {
  if (value === '') return 'PATH is empty';

  const bad = value.split(':').find((entry) => entry === '' || !path.isAbsolute(entry));

  if (bad === undefined) return undefined;

  return bad === ''
    ? 'PATH has an empty entry (a leading, trailing or doubled colon)'
    : `PATH has the relative entry "${bad}"`;
}

/** The token file's text: one line, the variable the server reads. */
export function renderTokenFile(token: string): string {
  return `${TOKEN_VARIABLE}=${token}\n`;
}

/** The token in a token file's text, or `undefined` when it is not one this command wrote. */
export function parseTokenFile(text: string): string | undefined {
  return TOKEN_LINE.exec(text.trim())?.[1];
}

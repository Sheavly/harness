import { readFile } from 'node:fs/promises';
import { isMissingPath } from '@sheavly/runtime/errors/errors.utils';
import { removeTextFile } from '@sheavly/storage/json-file/json-file.helper';
import { ServiceError } from '../errors/cli.errors.js';
import { UNIT_NAME } from './service.constants.js';
import type { ServiceDeps } from './service.types.js';
import { filesFor } from './service-files.helper.js';
import { parseTokenFile } from './service-files.utils.js';
import { requireSystemdUser } from './system-guards.helper.js';
import { STOPPED_STATES } from './service.constants.js';

/** What `service.env` is: not there, a token file this command wrote, or some other file. */
async function tokenFileState(file: string): Promise<'none' | 'ours' | 'foreign'> {
  try {
    return parseTokenFile(await readFile(file, 'utf8')) === undefined ? 'foreign' : 'ours';
  } catch (caughtError) {
    if (isMissingPath(caughtError)) return 'none';

    throw caughtError;
  }
}

/** The lines `uninstall` ends with, for what it removed and what it left. */
function summary(params: {
  unit: { file: string; removed: boolean };
  token: { file: string; state: 'none' | 'ours' | 'foreign' };
  home: string;
}): string {
  const { unit, token, home } = params;

  if (!unit.removed && token.state === 'none') return 'Nothing was installed.\n';

  return [
    `${unit.removed ? `Removed ${unit.file}` : 'The unit was not there'}${token.state === 'ours' ? ` and ${token.file}` : ''}.`,
    token.state === 'foreign'
      ? `${token.file} is not a token file this command wrote, so it was left: remove it yourself if it is not yours.`
      : '',
    `Your data in ${home} is untouched, and linger is still on: "loginctl disable-linger" turns it off.`,
    '',
  ]
    .filter((line, index, lines) => line !== '' || index === lines.length - 1)
    .join('\n');
}

/**
 * `uninstall`: stops and disables the service, removes the unit and the token file, and leaves the
 * user's data and linger alone, saying how to turn linger off. Nothing installed is fine. It
 * removes nothing while the service is still running (the stop failed or timed out), since a
 * server that keeps running without its token file would be restarted without a token, and it
 * removes `service.env` only when it is a token file this command wrote. The files are those of
 * this shell's `SHEAVLY_HOME`, which is the one the unit names unless it was installed from a
 * shell with another.
 */
export async function uninstallService(params: {
  deps: ServiceDeps;
  env: NodeJS.ProcessEnv;
}): Promise<void> {
  const { deps, env } = params;
  const { system, streams } = deps;
  const files = filesFor({ deps, env });

  await requireSystemdUser(deps);

  // The service may be stopped, disabled or not loaded at all: none of those is a reason to stop.
  await system.run({ tool: 'systemctl', args: ['--user', 'disable', '--now', UNIT_NAME] });

  const stopped = await system.run({
    tool: 'systemctl',
    args: ['--user', 'is-active', UNIT_NAME],
  });

  // Only a state that says it is stopped counts: `deactivating` (a stop that outlasts the time
  // limit here), `activating`, and an answer that did not come (empty) all leave it unknown.
  if (!STOPPED_STATES.includes(stopped.stdout.trim())) {
    throw new ServiceError(
      'The service may still be running after it was asked to stop, so nothing was removed: run "sheavly service stop", check "sheavly service status", and uninstall again.',
    );
  }

  const removed = await removeTextFile({ file: files.unit });
  const state = await tokenFileState(files.tokenFile);

  if (state === 'ours') await removeTextFile({ file: files.tokenFile });

  await system.run({ tool: 'systemctl', args: ['--user', 'daemon-reload'] });
  streams.out(
    summary({
      unit: { file: files.unit, removed },
      token: { file: files.tokenFile, state },
      home: files.home,
    }),
  );
}

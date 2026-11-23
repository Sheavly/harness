import { stat } from 'node:fs/promises';
import { isMissingPath } from '@sheavly/runtime/errors/errors.utils';
import { ServiceError } from '../errors/cli.errors.js';
import { LOG_LINES, UNIT_NAME } from './service.constants.js';
import type { ServiceDeps } from './service.types.js';
import { filesFor } from './service-files.helper.js';
import { requireSystemdUser, runOrThrow } from './system-guards.helper.js';

/** Whether `file` is there. */
async function isThere(file: string): Promise<boolean> {
  try {
    await stat(file);

    return true;
  } catch (caughtError) {
    if (isMissingPath(caughtError)) return false;

    throw caughtError;
  }
}

/** The `KEY=value` lines of `systemctl show` as a map. */
function properties(text: string): Map<string, string> {
  const pairs = text.split('\n').map((line): [string, string] => {
    const at = line.indexOf('=');

    return [line.slice(0, at), line.slice(at + 1)];
  });

  return new Map(pairs.filter(([key]) => key !== ''));
}

/**
 * `start`, `stop` and `restart`: the systemd command of that name for the service, after checking
 * it is installed. Stopping and restarting end the conversations that are running, and say so.
 */
export async function controlService(params: {
  deps: ServiceDeps;
  env: NodeJS.ProcessEnv;
  action: 'start' | 'stop' | 'restart';
}): Promise<void> {
  const { deps, env, action } = params;

  await requireSystemdUser(deps);

  if (!(await isThere(filesFor({ deps, env }).unit))) {
    throw new ServiceError('The service is not installed: run "sheavly service install" first.');
  }

  // A server that kept failing is `failed (start-limit-hit)`, and systemd refuses to start it
  // until that is cleared. Asking to start or restart it is asking to try again.
  if (action !== 'stop') {
    await deps.system.run({ tool: 'systemctl', args: ['--user', 'reset-failed', UNIT_NAME] });
  }

  await runOrThrow({ system: deps.system, tool: 'systemctl', args: ['--user', action, UNIT_NAME] });

  const done = { start: 'Started.', stop: 'Stopped.', restart: 'Restarted.' }[action];

  deps.streams.out(`${done}\n`);

  if (action !== 'start') {
    deps.streams.out('Conversations that were running stopped with the server.\n');
  }
}

/**
 * `status`: whether the service is installed, enabled and running, and whether linger is on, one
 * line each. Throws a `ServiceError` (exit 1) after printing when it is not running, as a check.
 */
export async function serviceStatus(params: {
  deps: ServiceDeps;
  env: NodeJS.ProcessEnv;
}): Promise<void> {
  const { deps, env } = params;
  const { system, streams } = deps;
  const unit = filesFor({ deps, env }).unit;

  await requireSystemdUser(deps);

  const installed = await isThere(unit);
  const show = await system.run({
    tool: 'systemctl',
    args: [
      '--user',
      'show',
      '-p',
      'ActiveState',
      '-p',
      'SubState',
      '-p',
      'ActiveEnterTimestamp',
      UNIT_NAME,
    ],
  });
  const enabled = await system.run({
    tool: 'systemctl',
    args: ['--user', 'is-enabled', UNIT_NAME],
  });
  const linger = await system.run({
    tool: 'loginctl',
    args: ['show-user', String(deps.uid), '-p', 'Linger'],
  });
  const state = properties(show.stdout);
  const running = state.get('ActiveState') === 'active';

  streams.out(
    [
      `installed: ${installed ? `yes (${unit})` : 'no'}`,
      `enabled: ${enabled.stdout.trim() === 'enabled' ? 'yes' : 'no'}`,
      `running: ${running ? `yes (${state.get('SubState') ?? 'running'} since ${state.get('ActiveEnterTimestamp') ?? '?'})` : 'no'}`,
      `linger: ${properties(linger.stdout).get('Linger') === 'yes' ? 'yes' : 'no'}`,
      '',
    ].join('\n'),
  );

  if (!installed) {
    throw new ServiceError('The service is not installed: run "sheavly service install".');
  }

  if (!running) {
    throw new ServiceError('The service is not running: run "sheavly service start".');
  }
}

/** `logs`: the service's journal, the last lines or, with `--follow`, as they come. */
export async function serviceLogs(params: {
  deps: ServiceDeps;
  args: readonly string[];
}): Promise<void> {
  const { deps, args } = params;

  for (const arg of args) {
    if (arg !== '--follow') {
      throw new ServiceError(`"sheavly service logs" takes --follow only, got "${arg}".`);
    }
  }

  await requireSystemdUser(deps);

  const follow = args.includes('--follow');
  const code = await deps.system.follow({
    tool: 'journalctl',
    args: ['--user', '-u', UNIT_NAME, '-n', String(LOG_LINES), follow ? '--follow' : '--no-pager'],
  });

  if (code === 'missing') {
    throw new ServiceError('journalctl is not installed, so the journal cannot be shown here.');
  }

  if (code !== 0) throw new ServiceError(`journalctl ended with exit ${String(code)}.`);
}

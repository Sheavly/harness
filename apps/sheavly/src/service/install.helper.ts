import { randomBytes } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { isMissingPath } from '@sheavly/runtime/errors/errors.utils';
import { assertPrivateFile, writeTextFile } from '@sheavly/storage/json-file/json-file.helper';
import { ServiceError, UsageError } from '../errors/cli.errors.js';
import { PLAIN_PATH, TOKEN_BYTES, UNIT_NAME } from './service.constants.js';
import type { ServiceDeps, ServiceFiles } from './service.types.js';
import { filesFor } from './service-files.helper.js';
import { parseTokenFile, pathProblem, renderTokenFile } from './service-files.utils.js';
import { requireSystemdUser, runOrThrow } from './system-guards.helper.js';
import { renderUnit } from './unit.utils.js';

/** The text of `file`, or `undefined` when there is none. */
async function readIfThere(file: string): Promise<string | undefined> {
  try {
    return await readFile(file, 'utf8');
  } catch (caughtError) {
    if (isMissingPath(caughtError)) return undefined;

    throw caughtError;
  }
}

/**
 * The token the service already has, or a new one. Installing again keeps it, so a client that
 * has the token is not locked out; a token file that others can read, or that holds something
 * else, is refused rather than replaced, since a token may already have been seen.
 */
async function tokenFor(file: string): Promise<{ token: string; existing: boolean }> {
  await assertPrivateFile({ file });

  const text = await readIfThere(file);

  if (text === undefined) {
    return { token: randomBytes(TOKEN_BYTES).toString('base64url'), existing: false };
  }

  const token = parseTokenFile(text);

  if (token === undefined) {
    throw new ServiceError(
      `${file} is not a token file this command wrote: move it away, or remove it, and install again.`,
    );
  }

  return { token, existing: true };
}

/** What `install` refuses before it asks or changes anything. */
function refuse(params: {
  args: readonly string[];
  deps: ServiceDeps;
  env: NodeJS.ProcessEnv;
  envFile: string;
}): void {
  const { args, deps, env, envFile } = params;

  for (const arg of args) {
    if (arg === '--trust') {
      throw new ServiceError(
        'The service does not take --trust: a server-wide --trust would trust every folder with hooks or settings that any conversation opens. Trust a folder from the chat instead.',
      );
    }

    if (arg !== '--yes') {
      throw new UsageError(`"sheavly service install" takes --yes only, got "${arg}".`);
    }
  }

  if (path.basename(deps.cliPath) !== 'cli.js') {
    throw new ServiceError(
      'The service runs the built command, and this one runs from source: build first (npm run build), then run node apps/sheavly/dist/cli.js service install.',
    );
  }

  const problem = pathProblem(env.PATH ?? '');

  if (problem !== undefined) {
    throw new ServiceError(
      `${problem}, and it would be written into the unit for a server that is always on and for every command an agent runs: fix PATH in this shell, then install again.`,
    );
  }

  if (!PLAIN_PATH.test(envFile)) {
    throw new ServiceError(
      `The token file's path (${envFile}) has characters a unit file cannot take safely: set SHEAVLY_HOME to a path of letters, digits and . _ / @ + - only.`,
    );
  }
}

/** What the command says it is about to do, so the user can say no. */
function plan(params: { files: ServiceFiles; cliPath: string; path: string }): string {
  const { files, cliPath, path: searchPath } = params;
  const { unit, tokenFile, home } = files;

  return [
    'This will:',
    `  write ${unit}, which runs the built command (${cliPath} serve, so it runs whatever that file holds at every start)`,
    `  set SHEAVLY_HOME=${home} and PATH=${searchPath} for the server and the commands an agent runs`,
    `  keep the server's token in ${tokenFile}, readable only by you, and never in the unit`,
    '  turn on linger for your user (loginctl enable-linger), so the server runs when you are logged out',
    '  enable the service and start it, without --trust',
    '',
  ].join('\n');
}

/**
 * `sheavly service install`: tells the user what it will do and asks (`--yes` skips the question;
 * without a terminal it refuses to guess), then writes the token file and the unit, turns on
 * linger, enables and starts the service. Installing again is harmless: it keeps the token,
 * rewrites the unit with the current paths, and does not restart a running service; it says when
 * the unit changed and that `restart` applies it, since a restart stops running conversations.
 * Throws a `ServiceError` for what it refuses or a systemd command that failed.
 */
export async function installService(params: {
  deps: ServiceDeps;
  env: NodeJS.ProcessEnv;
  args: readonly string[];
}): Promise<void> {
  const { deps, env, args } = params;
  const { system, streams } = deps;
  const files = filesFor({ deps, env });

  refuse({ args, deps, env, envFile: files.tokenFile });
  await requireSystemdUser(deps);
  streams.out(plan({ files, cliPath: deps.cliPath, path: env.PATH ?? '' }));

  if (!args.includes('--yes')) {
    if (!deps.interactive) {
      throw new ServiceError(
        'Installing asks first, and there is no terminal to ask in: pass --yes to go on.',
      );
    }

    if (!(await deps.confirm('Install and start the service? [y/N] '))) {
      streams.out('Nothing was changed.\n');

      return;
    }
  }

  const { token, existing } = await tokenFor(files.tokenFile);
  const unit = renderUnit({
    nodePath: deps.nodePath,
    cliPath: deps.cliPath,
    home: files.home,
    path: env.PATH ?? '',
    envFile: files.tokenFile,
  });
  const before = await readIfThere(files.unit);

  if (!existing) await writeTextFile({ file: files.tokenFile, text: renderTokenFile(token) });

  await writeTextFile({ file: files.unit, text: unit });

  for (const [tool, toolArgs] of [
    ['systemctl', ['--user', 'daemon-reload']],
    ['loginctl', ['enable-linger']],
    ['systemctl', ['--user', 'enable', UNIT_NAME]],
    ['systemctl', ['--user', 'start', UNIT_NAME]],
  ] as const) {
    await runOrThrow({ system, tool, args: toolArgs });
  }

  streams.out(
    'Installed and enabled, and systemd was asked to start it. `sheavly service status` says whether it is running, and `sheavly service logs` why not.\n',
  );

  if (before !== undefined && before !== unit) {
    streams.out(
      'The unit changed: `sheavly service restart` applies it (it stops running conversations).\n',
    );
  }
}

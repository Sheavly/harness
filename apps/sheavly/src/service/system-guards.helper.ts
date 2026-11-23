import { ServiceError } from '../errors/cli.errors.js';
import type { SystemTool, SystemTools } from './service.types.js';

/** The first line of a program's error output, which is what a one-line message can carry. */
function firstLine(text: string): string {
  return text.trim().split('\n')[0] ?? '';
}

/**
 * Runs a systemd program and throws a `ServiceError` with its first error line when it did not
 * exit 0. Nothing it prints is secret: the token is never an argument or in a unit.
 */
export async function runOrThrow(params: {
  system: SystemTools;
  tool: SystemTool;
  args: readonly string[];
}): Promise<string> {
  const { system, tool, args } = params;
  const result = await system.run({ tool, args });

  if (result.status === 'ok') return result.stdout;

  const why = result.status === 'missing' ? 'it is not installed' : firstLine(result.stderr);

  throw new ServiceError(
    `${tool} ${args.join(' ')} failed: ${why || `exit ${String(result.code)}`}`,
  );
}

/**
 * Throws a `ServiceError` unless this is Linux with a systemd user manager to talk to: the only
 * place the service exists. It says what is missing and to run `sheavly serve` instead.
 */
export async function requireSystemdUser(params: {
  platform: NodeJS.Platform;
  system: SystemTools;
}): Promise<void> {
  const { platform, system } = params;

  if (platform !== 'linux') {
    throw new ServiceError(
      `The service needs Linux with systemd, and this is ${platform}: run "sheavly serve" in a terminal instead.`,
    );
  }

  const result = await system.run({ tool: 'systemctl', args: ['--user', 'show-environment'] });

  if (result.status === 'missing') {
    throw new ServiceError(
      'systemd user services are not available here (systemctl is not installed): run "sheavly serve" in a terminal instead.',
    );
  }

  if (result.status === 'failed') {
    throw new ServiceError(
      'systemd user services are not available here (no user manager is running for you, as in a container or without a login session, or this shell has no runtime directory for it, as after su or sudo): run "sheavly serve" in a terminal instead.',
    );
  }
}

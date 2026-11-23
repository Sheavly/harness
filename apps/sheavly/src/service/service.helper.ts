import type { CliCommand } from '../command/command.types.js';
import { UsageError } from '../errors/cli.errors.js';
import { installService } from './install.helper.js';
import { controlService, serviceLogs, serviceStatus } from './manage.helper.js';
import {
  SERVICE_ACTIONS,
  SERVICE_HELP,
  SERVICE_NAME,
  SERVICE_SUMMARY,
} from './service.constants.js';
import type { ServiceAction, ServiceDeps } from './service.types.js';
import { uninstallService } from './uninstall.helper.js';

/** The action named by `word`, or `undefined` when it is none of them. */
function actionOf(word: string | undefined): ServiceAction | undefined {
  return SERVICE_ACTIONS.find((action) => action === word);
}

/**
 * The `service` command: runs the server as a systemd user service (`install`, `uninstall`,
 * `start`, `stop`, `restart`, `status`, `logs`). Everything the process provides (the platform,
 * the paths of node and of this command, the systemd programs, a way to ask the user) is passed in
 * so a test supplies its own. A refusal or a failed systemd command is a `ServiceError`; an unknown
 * action is a `UsageError`. It never prints the token, and it never writes it into a unit.
 */
export function createServiceCommand(deps: ServiceDeps): CliCommand {
  return {
    name: SERVICE_NAME,
    summary: SERVICE_SUMMARY,
    help: SERVICE_HELP,
    run: async ({ args, env }) => {
      const [word, ...rest] = args;
      const action = actionOf(word);

      if (action === undefined) {
        throw new UsageError(
          `"sheavly service" takes one of ${SERVICE_ACTIONS.join(', ')}, got ${word === undefined ? 'nothing' : `"${word}"`}. Run "sheavly service --help".`,
        );
      }

      if (action === 'install') return installService({ deps, env, args: rest });

      if (action === 'logs') return serviceLogs({ deps, args: rest });

      if (rest.length > 0) {
        throw new UsageError(
          `"sheavly service ${action}" takes no argument, got "${rest[0] ?? ''}". Run "sheavly service --help".`,
        );
      }

      if (action === 'uninstall') return uninstallService({ deps, env });

      if (action === 'status') return serviceStatus({ deps, env });

      return controlService({ deps, env, action });
    },
  };
}

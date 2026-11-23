import { sheavlyHome } from '@sheavly/storage/home/home.helper';
import type { ServiceDeps, ServiceFiles } from './service.types.js';
import { serviceFiles } from './service-files.utils.js';

/**
 * Where the service's files are for the user running this command: the unit in their systemd
 * folder and the token file in the Sheavly home `env` names (`SHEAVLY_HOME`, else `~/.sheavly`).
 */
export function filesFor(params: { deps: ServiceDeps; env: NodeJS.ProcessEnv }): ServiceFiles {
  const { deps, env } = params;

  return serviceFiles({ env, homeDir: deps.homeDir, sheavlyHome: sheavlyHome(env) });
}

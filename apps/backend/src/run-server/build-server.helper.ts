import { randomBytes } from 'node:crypto';
import { createAdaptorServer } from '@hono/node-server';
import type { Environment } from '@sheavly/core/environment/environment.types';
import { createApiApp } from '../api/api.helper.js';
import { createBackend } from '../backend.helper.js';
import type { ServedSettings } from '../harness/harness.types.js';
import { newInstanceId } from '../instance/instance-id.helper.js';
import { configureServerTimeouts } from '../listen/server-timeouts.helper.js';
import { readServerVersion } from '../version/server-version.helper.js';
import type { BuiltServer, ServerSettings } from './run-server.types.js';

/**
 * Builds everything a start needs before it takes anything: the token, the backend, the API and
 * the server that does not listen yet. Everything that can fail on a setting or a build is here,
 * so no error can leave the lock behind.
 */
export async function buildServer(params: {
  env: Environment;
  settings: ServedSettings;
  server: ServerSettings;
  log: (text: string) => void;
}): Promise<BuiltServer> {
  const { env, settings, server, log } = params;
  const token = server.token ?? randomBytes(32).toString('base64url');
  // Made once per start and returned by no route: it only salts the handshake proof.
  const instanceId = newInstanceId();
  const serverVersion = await readServerVersion();
  const { conversations, setup, workspaces, permissions, logs } = createBackend({
    env,
    settings,
    log,
    remoteSetupAllowed: server.remoteSetupAllowed,
  });
  const app = createApiApp({
    conversations,
    setup,
    workspaces,
    permissions,
    token,
    instanceId,
    serverVersion,
    logs,
  });
  const listening = createAdaptorServer({ fetch: app.fetch, hostname: server.host });

  // Two public routes read a body without a token: a client that trickles one is cut off.
  configureServerTimeouts({ server: listening });

  return { listening, conversations, logs, token, instanceId, serverVersion };
}

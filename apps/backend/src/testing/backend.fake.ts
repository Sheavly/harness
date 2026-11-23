import { createClient } from '@sheavly/client/client/client.helper';
import { createDefaultRegistry } from '@sheavly/providers/registry/default-registry.helper';
import { createApiApp } from '../api/api.helper.js';
import { createBackend } from '../backend.helper.js';
import { parseCliSettings, parseRunEnv } from '../harness/settings.validator.js';
import { TEST_INSTANCE_ID } from './identity.fake.js';
import { TEST_SERVER_VERSION, TEST_TOKEN } from './testing.constants.js';

/**
 * Test-only: the real backend (`createBackend`, as `serve.ts` makes it) over a user's folder `home`
 * and with `workspace` as its own folder, and its HTTP app. `call` sends a request to it with the
 * token, as a client does; `client` is the real `@sheavly/client` over the same app. `fetch` stands in for the network (models, key checks); `env` adds
 * settings (`MODEL_CALLS_FILE`, `SHOW_MODEL_CALLS`...). `token` replaces `TEST_TOKEN` as the
 * server's token. `logged` is what it told its log.
 */
export function testBackend(params: {
  home: string;
  workspace: string;
  fetch?: typeof globalThis.fetch;
  env?: Record<string, string>;
  remoteSetupAllowed?: boolean;
  token?: string;
}) {
  const { home, workspace, fetch, remoteSetupAllowed = true, token = TEST_TOKEN } = params;
  const env = { ...params.env, SHEAVLY_HOME: home, WORKSPACE_ROOT: workspace };
  const logged: string[] = [];
  const { conversations, setup, workspaces, permissions, logs } = createBackend({
    env,
    settings: { ...parseCliSettings({ env, args: [] }), ...parseRunEnv(env) },
    log: (text) => logged.push(text),
    remoteSetupAllowed,
    ...(fetch && { adapters: createDefaultRegistry({ fetch }) }),
  });
  const app = createApiApp({
    conversations,
    setup,
    workspaces,
    permissions,
    token,
    instanceId: TEST_INSTANCE_ID,
    serverVersion: TEST_SERVER_VERSION,
    logs,
  });
  const call = (path: string, init: { method?: string; body?: unknown } = {}) =>
    app.request(path, {
      method: init.method ?? 'GET',
      headers: {
        authorization: `Bearer ${token}`,
        ...(init.body !== undefined && { 'content-type': 'application/json' }),
      },
      ...(init.body !== undefined && { body: JSON.stringify(init.body) }),
    });

  return {
    conversations,
    setup,
    workspaces,
    permissions,
    logs,
    app,
    call,
    logged,
    client: clientFor(app),
  };
}

/** A client whose requests go straight to `app`, so no server needs to listen. */
function clientFor(app: ReturnType<typeof createApiApp>) {
  return createClient({
    url: 'http://backend.test',
    token: TEST_TOKEN,
    fetch: async (input, init) => app.request(new Request(input, init)),
  });
}

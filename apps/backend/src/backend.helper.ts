import type { Environment } from '@sheavly/core/environment/environment.types';
import { Conversations } from '@sheavly/host/conversations/conversations.service';
import type { AdapterRegistry } from '@sheavly/providers/registry/registry.service';
import { sheavlyHome } from '@sheavly/storage/home/home.helper';
import { servedConversation } from './harness/served.helper.js';
import { createBackendLogs } from './logging/backend-logs.helper.js';
import type { BackendLogs } from './logging/logging.types.js';
import type { ServedSettings } from './harness/harness.types.js';
import { SearchChains } from './harness/search-chains.service.js';
import { parseRequestEnv } from './harness/settings.validator.js';
import { permissionStoreFor, trustStoreFor } from './profiles/home.helper.js';
import { PermissionSetup } from './profiles/permission-setup.service.js';
import { PlacedConversationStore } from './profiles/placed-conversation-store.service.js';
import { Profiles } from './profiles/profiles.service.js';
import { createReplayDropLog } from './profiles/replay-drop-log.helper.js';
import type { ProfileSetup } from './profiles/setup.service.js';
import type { WorkspaceSetup } from './profiles/workspace-setup.service.js';
import { KeyedLocks } from '@sheavly/runtime/locks/keyed-locks.service';
import { LOG_EVENT } from './logging/logging.constants.js';

/**
 * The backend's two halves, built on one set of profiles so a change made through `setup` shows in
 * the next conversation: the conversations, each placed in a folder on a profile (what its start
 * asked for, else this backend's folder and that folder's profile) and kept there in the user's
 * folder, so a restart finds them (`listStored`, `reopen`) and several can run at once; and the
 * setup a UI uses to make that profile in the first place. The one place that puts the pieces
 * together, which `serve.ts` and the tests share.
 *
 * `adapters` is for a test's fake `fetch`. `log` hears what a person should see: models and skills
 * that were left out, each model call with `SHOW_MODEL_CALLS`, and stored conversations that
 * can't be used; `logs` takes the failures that end without a caller to tell. `remoteSetupAllowed` is whether this backend may hand out access over a network
 * (a key, a trust; see `ProfileSetup`).
 */
export function createBackend(params: {
  env: Environment;
  settings: ServedSettings;
  log: (text: string) => void;
  remoteSetupAllowed: boolean;
  adapters?: AdapterRegistry;
}): {
  conversations: Conversations;
  setup: ProfileSetup;
  workspaces: WorkspaceSetup;
  permissions: PermissionSetup;
  logs: BackendLogs;
} {
  const { env, settings, log, remoteSetupAllowed, adapters } = params;
  const profiles = new Profiles({
    env,
    ...(adapters && { adapters }),
    // A person sees why a model lost its reasoning, once per kind: a drop that repeats every call
    // (a changing notice moves the request prefix) is one line, not one per call. With
    // `SHOW_MODEL_CALLS` every drop is told, under the model call that made it.
    onReplayDropped: createReplayDropLog({ log, everyDrop: settings.showModelCalls }),
  });
  const trustStore = trustStoreFor(env);
  const permissionStore = permissionStoreFor(env);
  const places = new PlacedConversationStore({
    profiles,
    fallbackWorkspace: settings.workspaceRoot ?? process.cwd(),
    onProblem: ({ file, message }) => log(`Stored conversation ${file} is left out: ${message}\n`),
  });
  // Where an error ends is logged here: stderr, and a file under the home (see `BackendLogs`).
  const logs = createBackendLogs({ home: sheavlyHome(env), places, log });
  // One set for every conversation of this backend: they key by real path, so two conversations
  // editing one file take turns, whichever profile each runs on.
  const fileLocks = new KeyedLocks();
  // Likewise for search: one chain per backend order, so a rate limit is remembered by all.
  const searchChains = new SearchChains();

  return {
    logs,
    setup: profiles.setup({ request: parseRequestEnv(env), remoteSetupAllowed }),
    // The same trust store the conversations read, so a grant shows in the next one.
    workspaces: profiles.workspaces({ trust: trustStore, remoteSetupAllowed }),
    // The same store the conversations read on every command, so a change applies to them at once.
    permissions: new PermissionSetup({
      store: permissionStore,
      home: sheavlyHome(env),
      env,
      remoteSetupAllowed,
    }),
    conversations: new Conversations({
      store: places,
      onPromptFailure: ({ id, error }) =>
        logs.conversation(id).error(LOG_EVENT.PROMPT_FAILED, { error }),
      create: (asked) =>
        servedConversation({
          env,
          profiles,
          places,
          trustStore,
          permissionStore,
          settings,
          asked,
          fileLocks,
          searchChains,
          log,
          logs,
        }),
    }),
  };
}

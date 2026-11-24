import { homedir } from 'node:os';
import type { Environment } from '@sheavly/core/environment/environment.types';
import type {
  CreateConversation,
  LiveConversation,
} from '@sheavly/host/conversations/conversations.types';
import type { ModelEffort, ModelId } from '@sheavly/protocol/model/model.types';
import type { PermissionStore } from '@sheavly/storage/permission-store/permission-store.service';
import type { TrustStore } from '@sheavly/coding/trust/trust.service';
import type { KeyedLocks } from '@sheavly/runtime/locks/keyed-locks.service';
import { findSkills } from '@sheavly/coding/skills/skills.helper';
import { harnessConversation } from './conversation.helper.js';
import { createBackendHarness } from './harness.helper.js';
import type { SearchChains } from './search-chains.service.js';
import type { ServedSettings } from './harness.types.js';
import { LOG_EVENT } from '../logging/logging.constants.js';
import type { BackendLogs } from '../logging/logging.types.js';
import { startOnRequestedModel } from './starting-model.helper.js';
import { reportedWorkingRoot } from './working-root-report.helper.js';
import { modelCallsTo } from './model-calls.helper.js';
import { skillsNotice } from './notices.utils.js';
import { readUserSettingLayers } from './setting-layers.helper.js';
import { ignoredSettingLines } from './setting-layers.utils.js';
import { sharedScratchRoot } from './scratch.helper.js';
import { backendSummary, subAgentSummary } from './summary.helper.js';
import { workspacePermissions } from './permissions.helper.js';
import type { PlacedConversationStore } from '../profiles/placed-conversation-store.service.js';
import type { Profiles } from '../profiles/profiles.service.js';
import type { WorkspaceModels } from '../profiles/profiles.types.js';
import { parseRequestEnv } from './settings.validator.js';
import { selectedProvider } from './selected-provider.helper.js';
import { trackConversationUsage } from '../usage/conversation-usage.helper.js';
import { conversationContextUsage } from '../usage/context-usage.helper.js';

/**
 * One conversation as the backend serves it: placed in a folder on a profile (what the start asked
 * for, or the backend's own folder and the profile its workspace is bound to), with its own
 * models (the profile's, behind its own switch, so changing this conversation's model leaves the
 * others alone), the harness on the settings, and the run it reports (the UI shows its trust from
 * that). The global and the bound profile's `settings.json` are read here, so a malformed one
 * fails the start naming the file; settings the workspace's file asked for that did not apply go
 * to `log` (one line each, never a value) and to the details. Skills that didn't load go to `log`, and each model call to `MODEL_CALLS_FILE` and, with
 * SHOW_MODEL_CALLS, to `log`.
 *
 * `places` decides the placement once per conversation and remembers it by `id`, so the store
 * knows where the conversation's files go before its first one is written.
 *
 * Throws a `SetupError` (`invalid`) for a workspace or profile that can't be used, or a global or
 * profile settings file that can't (its message names the file and the reason), and a
 * `ConversationsError` (`not_set_up`) when no profile with a usable model can be found; models
 * that were left out are noted on `log`.
 */
export async function servedConversation(params: {
  env: Environment;
  profiles: Profiles;
  places: PlacedConversationStore;
  trustStore: TrustStore;
  /** What the user lets `run_command` do in each folder; every conversation reads its folder's. */
  permissionStore: PermissionStore;
  settings: ServedSettings;
  asked: Parameters<CreateConversation>[0];
  /** Shared with the backend's other conversations, so edits to one file take turns. */
  fileLocks: KeyedLocks;
  /** Shared with the backend's other conversations, so a rate-limited backend is skipped by all. */
  searchChains: SearchChains;
  log: (text: string) => void;
  /** Where an error that ends without a caller is logged, under this conversation's id. */
  logs: BackendLogs;
}): Promise<LiveConversation> {
  const {
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
  } = params;
  const { id, messages, storage } = asked;
  const logger = logs.conversation(id);
  const placement = await places.decide({ id, asked });
  const permissions = workspacePermissions({
    store: permissionStore,
    workspace: placement.workspace,
    env,
  });
  const workspace = await profiles.modelsFor({
    placement,
    request: parseRequestEnv(env),
    contextWindow: settings.contextWindow,
  });

  // A new conversation that names a model runs on it, for this conversation only. A resumed one
  // keeps its own selection below and never looks the name up, so a stale name cannot fail it.
  if (asked.model && !asked.modelSelection) {
    startOnRequestedModel({ models: workspace.models, requested: asked.model });
  }

  // Like the model, a requested effort is for this new conversation only and is never remembered.
  const active = workspace.models.switch.active;

  if (asked.effort && active && !asked.modelSelection) {
    workspace.models.switch.setEffort({ name: active, effort: asked.effort });
  }

  // Resume the conversation's own selection, never a newer selection from another conversation.
  if (asked.modelSelection) {
    workspace.models.switch.use(asked.modelSelection.modelId);
    workspace.models.switch.setEffort({
      name: asked.modelSelection.modelId,
      effort: asked.modelSelection.effort,
    });
  }

  for (const note of workspace.notes) log(`${note}\n`);

  const onModelCall = modelCallsTo({ settings, log });
  // The conversation's model switch writes the summaries, so a switch changes who summarizes.
  const summary = settings.summary ? backendSummary(workspace.models.switch) : undefined;
  const harness = await createBackendHarness({
    // The bound profile's file, so a conversation never reads another profile's; unusable: no start.
    settingLayers: await readUserSettingLayers({ env, profile: placement.profile }),
    provider: workspace.models.switch,
    ...(settings.summary && { summarizeWith: subAgentSummary }),
    subAgentProvider: () => selectedProvider({ models: workspace.models, onModelCall }),
    workspaceRoot: placement.workspace,
    scratchRoot: sharedScratchRoot(),
    fileLocks,
    permissions,
    title: 'Conversation',
    trustStore,
    env,
    trustWorkspace: settings.trustWorkspace,
    webFetch: settings.webFetch ? {} : false,
    webSearch: settings.webSearch
      ? { backend: searchChains.chainFor(settings.webSearchBackends) }
      : false,
    home: homedir(),
    onModelCall,
    onFileReadsProblem: (caughtError) =>
      logger.error(LOG_EVENT.FILE_READS_PROBLEM, { error: caughtError }),
    onExtensionProblem: (caughtError) =>
      logger.error(LOG_EVENT.EXTENSION_PROBLEM, { error: caughtError }),
    ...(storage && {
      entries: storage.entries,
      resume: storage.resume,
      channels: storage.channels,
      shell: storage.shell,
      outputs: storage.outputs,
      keepAgentHistory: storage.keepAgentHistory,
      logOf: storage.logOf,
    }),
  });
  const skills = skillsNotice(await findSkills(harness.skills));

  if (skills) log(`${skills}\n`);

  const ignoredLines = ignoredSettingLines({
    ignored: harness.ignoredSettings,
    more: harness.ignoredSettingsMore,
  });

  for (const line of ignoredLines) log(`${line}\n`);

  const usage = await trackConversationUsage({ sessions: harness.sessions, storage });

  return {
    ...harnessConversation({
      harness,
      messages,
      storage,
      logger,
      ...(settings.maxTurns !== undefined && { maxTurns: settings.maxTurns }),
      summary,
      run: {
        details: () => ({
          workspace: harness.workspace.root,
          profile: placement.profile,
          ...modelsIn(workspace),
          usage: usage.ledger.snapshot,
          contextUsage: conversationContextUsage({
            harness,
            throughSeq: usage.ledger.snapshot.throughSeq,
          }),
          projectTrust: harness.projectTrust,
          ...(harness.ignoredSettings.length > 0 && { ignoredSettings: harness.ignoredSettings }),
          ...(harness.ignoredSettingsMore > 0 && {
            ignoredSettingsMore: harness.ignoredSettingsMore,
          }),
        }),
        permissionMode: async () => (await permissions.read()).mode,
        workingRoot: () =>
          reportedWorkingRoot({
            workingRoots: harness.workingRoots,
            onFailure: (caughtError) =>
              logger.error(LOG_EVENT.WORKING_ROOT_FAILED, { error: caughtError }),
          }),
        useModel: (id, effort) => useModel({ workspace, id, ...(effort && { effort }) }),
      },
    }),
    dispose: async () => {
      usage.stop();
    },
  };
}

/** The model in use and the ones to switch to, all the profile's usable ones. */
function modelsIn(workspace: WorkspaceModels) {
  const { switch: active, choices } = workspace.models;

  return {
    model: {
      ...(choices.find((choice) => choice.id === active.active) ?? workspace.first),
      effort: active.activeEffort ?? 'medium',
    },
    models: choices,
  };
}

/**
 * Switches to the model with this id, and remembers it as the profile's last, where its next new
 * conversation starts. Without an explicit effort it restores this model's latest effort in the
 * profile. A failed preference write rejects the switch before the active selection changes.
 */
async function useModel(params: {
  workspace: WorkspaceModels;
  id: ModelId;
  effort?: ModelEffort;
}): Promise<boolean> {
  const { workspace, id } = params;

  if (!workspace.models.choices.some((choice) => choice.id === id)) return false;

  const effort = await workspace.select({
    modelId: id,
    ...(params.effort && { effort: params.effort }),
  });

  workspace.models.switch.setEffort({ name: id, effort });
  workspace.models.switch.use(id);

  return true;
}

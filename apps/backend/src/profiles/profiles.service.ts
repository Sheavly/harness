import type { ReplayDropHandler } from '@sheavly/core/adapter/replay.types';
import type { Environment } from '@sheavly/core/environment/environment.types';
import { ConversationsError } from '@sheavly/host/errors/conversations.errors';
import type { ModelEffort, ModelId } from '@sheavly/protocol/model/model.types';
import type { ProfileId } from '@sheavly/protocol/profile/profile.types';
import { createModelFetch } from '@sheavly/providers/http/model-fetch.helper';
import { createDefaultRegistry } from '@sheavly/providers/registry/default-registry.helper';
import type { AdapterRegistry } from '@sheavly/providers/registry/registry.service';
import { workspaceKey } from '@sheavly/storage/config-store/config-store.utils';
import { StorageFileError } from '@sheavly/storage/errors/storage.errors';
import type { FileConversationStore } from '@sheavly/storage/conversation-store/conversation-store.service';
import { sheavlyHome } from '@sheavly/storage/home/home.helper';
import type { FileProblem } from '@sheavly/storage/listing/listing.types';
import { ProfileRegistry } from '@sheavly/storage/profile-registry/profile-registry.service';
import type { TrustStore } from '@sheavly/coding/trust/trust.service';
import { SetupError } from '../errors/setup.errors.js';
import type { Placement, RequestSettings } from './profiles.types.js';
import { modelsOf } from './models.helper.js';
import { ProfileSetup } from './setup.service.js';
import { WorkspaceSetup } from './workspace-setup.service.js';
import type { WorkspaceModels } from './profiles.types.js';
import { resolveWorkspace } from './workspace-path.helper.js';

/**
 * The user's profiles as the backend uses them: which profile a workspace runs on, and the
 * models and keys in it. It is the one place in the backend that holds a key, so everything else
 * asks it for a built provider and never sees one.
 */
export class Profiles {
  readonly #registry: ProfileRegistry;
  readonly #adapters: AdapterRegistry;
  readonly #home: string;

  /** `env` says where the user's folder is (`sheavly_home`); `adapters` is for a test's fake fetch. */
  constructor(params: {
    env: Environment;
    adapters?: AdapterRegistry;
    /** Told of each reasoning item a model call leaves out; used only when `adapters` is not given. */
    onReplayDropped?: ReplayDropHandler;
  }) {
    this.#home = sheavlyHome(params.env);
    this.#registry = new ProfileRegistry({ root: this.#home });
    this.#adapters =
      params.adapters ??
      createDefaultRegistry({
        fetch: createModelFetch(),
        onReplayDropped: params.onReplayDropped,
      });
  }

  /**
   * What a setup UI uses to look at and change these profiles. It works on this class's own
   * registry, so a change shows in the next conversation. `remoteSetupAllowed` is whether this
   * backend may hand out access over a network (a key, a trust; see `ProfileSetup`); `request` is
   * the policy a stored model gets.
   */
  setup(params: { request: RequestSettings; remoteSetupAllowed: boolean }): ProfileSetup {
    return new ProfileSetup({
      registry: this.#registry,
      adapters: this.#adapters,
      home: this.#home,
      ...params,
    });
  }

  /**
   * What a setup UI uses to bind folders to profiles and to trust them. It works on this class's
   * registry and on `trust`, the store the backend's conversations read, so a binding or a grant
   * shows in the next conversation. See `WorkspaceSetup` for `remoteSetupAllowed`.
   */
  workspaces(params: { trust: TrustStore; remoteSetupAllowed: boolean }): WorkspaceSetup {
    return new WorkspaceSetup({ registry: this.#registry, home: this.#home, ...params });
  }

  /**
   * Decides where a new conversation belongs. `workspace` is the folder it works in (checked by
   * `resolveWorkspace`; the backend's own when omitted). `profile` is the one to run on; when
   * omitted, the profile the workspace is bound to, else the default. Throws a `SetupError`
   * (`invalid`) for a workspace that can't be used or a profile that doesn't exist, and a
   * `ConversationsError` (`not_set_up`) when no profile can be found at all.
   */
  async place(params: {
    workspace: string | undefined;
    profile: ProfileId | undefined;
    fallbackWorkspace: string;
  }): Promise<Placement> {
    const { workspace, profile, fallbackWorkspace } = params;
    const root = await resolveWorkspace({
      requested: workspace ?? fallbackWorkspace,
      sheavlyHome: this.#home,
    });

    if (profile !== undefined) {
      if (!(await this.#registry.get(profile))) {
        throw new SetupError({ reason: 'invalid', message: `There is no profile ${profile}` });
      }

      return { workspace: root, profile };
    }

    return { workspace: root, profile: (await this.#profileOf(root)).found.id };
  }

  /**
   * The models a conversation placed at `placement` runs on: its profile's usable ones behind
   * one switch, starting on the profile's last model.
   *
   * Throws a `ConversationsError` (`not_set_up`) when the profile has no model that can be used,
   * saying what to do. A model that cannot be built is left out with a note and never fails the
   * others.
   */
  async modelsFor(params: {
    placement: Placement;
    request: RequestSettings;
    /** The window every model is told, instead of its file's (`CONTEXT_WINDOW`). */
    contextWindow?: number | undefined;
  }): Promise<WorkspaceModels> {
    const { placement, request, contextWindow } = params;
    const found = await this.#profileNamed(placement.profile);
    const profile = await this.#registry.open(found.id);
    const { models, notes } = await modelsOf({
      profile,
      registry: this.#adapters,
      request,
      contextWindow,
      ...(found.lastModelSelection && { startWith: found.lastModelSelection.modelId }),
      ...(found.modelEfforts && { efforts: found.modelEfforts }),
    });

    // The switch starts on a model among the choices (see `modelsOf`), so with any choice at all
    // there is one in use. None at all is a profile with nothing usable.
    const first = models.choices.find((choice) => choice.id === models.switch.active);

    if (!first) {
      throw new ConversationsError({
        reason: 'not_set_up',
        message: [
          `The profile "${found.name}" has no model that can be used: add a model and set its key.`,
          ...notes,
        ].join('\n'),
      });
    }

    return {
      models,
      notes,
      first,
      select: async (selection: { modelId: ModelId; effort?: ModelEffort }) => {
        const profile = await this.#profileNamed(found.id);
        const effort = selection.effort ?? profile.modelEfforts?.[selection.modelId] ?? 'medium';

        await this.#registry.rememberModel({ id: found.id, modelId: selection.modelId, effort });

        return effort;
      },
    };
  }

  /**
   * The conversations of the placement's workspace under its profile, the store they are kept in.
   * `onProblem` hears of each stored conversation that can't be used (see `FileConversationStore`).
   */
  async conversationsFor(params: {
    placement: Placement;
    onProblem: (problem: FileProblem) => void;
  }): Promise<FileConversationStore> {
    const { placement, onProblem } = params;
    const profile = await this.#registry.open(placement.profile);

    return profile.conversations({ realPath: placement.workspace, onProblem });
  }

  /**
   * Every stored conversation's store, across all profiles and their workspaces, with where each
   * belongs: what listing and reopening look through. A profile or folder that can't be read is
   * told to `onProblem` and left out, so one bad folder never hides the rest.
   */
  async everyStore(params: {
    onProblem: (problem: FileProblem) => void;
  }): Promise<{ placement: Placement; store: FileConversationStore }[]> {
    const { onProblem } = params;
    const { profiles, problems } = await this.#registry.list();
    const found: { placement: Placement; store: FileConversationStore }[] = [];

    for (const problem of problems) onProblem(problem);

    for (const { id } of profiles) {
      const open = await this.#registry.open(id);

      for (const { root, store } of await open.workspaces({ onProblem })) {
        found.push({ placement: { workspace: root, profile: id }, store });
      }
    }

    return found;
  }

  /** The profile with this id, or a `SetupError` (`invalid`): it is the caller's to fix. */
  async #profileNamed(id: ProfileId) {
    const found = await this.#registry.get(id);

    if (!found) throw new SetupError({ reason: 'invalid', message: `There is no profile ${id}` });

    return found;
  }

  /** The profile the workspace runs on (bound, else the default), or `not_set_up`. */
  async #profileOf(workspaceRoot: string) {
    const key = workspaceKey({ realPath: workspaceRoot });
    const found = await this.#registry.profileFor(key).catch((caughtError: unknown) => {
      // A damaged config.json only stops a start that has to read it; naming the file lets the
      // user fix it, or start on an explicit profile, which never reads it.
      if (!(caughtError instanceof StorageFileError)) throw caughtError;

      throw new ConversationsError({
        reason: 'not_set_up',
        message: `The config ${caughtError.file} cannot be used (${caughtError.message}). Repair or delete it, or start the conversation on a named profile.`,
        cause: caughtError,
      });
    });

    if (!found) {
      throw new ConversationsError({
        reason: 'not_set_up',
        message: `No profile is set up for the workspace ${workspaceRoot}: create a profile with a model and its key, and make it the default.`,
      });
    }

    return { found };
  }
}

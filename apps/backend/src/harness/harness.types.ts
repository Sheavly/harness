import type { Extension, WorkKindContribution } from '@sheavly/extension/extension/extension.types';
import type { SettingInfo, SkippedExtension } from '@sheavly/extension/host/extension-host.types';
import type { LayeredSettings, SettingLayer } from '@sheavly/extension/host/setting-layers.types';
import type { Hook } from '@sheavly/core/hook/hook.types';
import type { Provider, ProviderRequest } from '@sheavly/core/provider/provider.types';
import type { SummaryOptions } from '@sheavly/core/summary/summary.types';
import type { Tool } from '@sheavly/core/tool/tool.types';
import type { OutputStore } from '@sheavly/core/output/output.types';
import type { Environment } from '@sheavly/core/environment/environment.types';
import type { DocumentStore, EntryStore } from '@sheavly/core/store/store.types';
import type { CommandPermissions } from '@sheavly/coding/run-command/run-command.types';
import type { StoredLog } from '@sheavly/runtime/sessions/sessions.types';
import type { ProviderSwitch } from '@sheavly/providers/switch/switch.service';
import type { IgnoredSettingReport, ModelChoice } from '@sheavly/protocol/server/server.types';
import type { ProjectTrust } from '@sheavly/coding/project-hooks/project-hooks.types';
import type { KeyedLocks } from '@sheavly/runtime/locks/keyed-locks.service';
import type { SkillRoots } from '@sheavly/coding/skills/skills.types';
import type { TrustStore } from '@sheavly/coding/trust/trust.service';
import type { WorkingRoots } from '@sheavly/workspace/working-root/working-roots.service';
import type { parseCliSettings, parseRunEnv } from './settings.validator.js';
import type { createSubAgentTool } from '@sheavly/tools/sub-agent/sub-agent.tool';
import type { HistoryToolOptions } from '@sheavly/tools/history/history.types';
import type { createWebFetchTool } from '@sheavly/tools/web-fetch/web-fetch.tool';
import type { createWebSearchTool } from '@sheavly/tools/web-search/web-search.tool';
import type { Harness, HarnessOptions } from '@sheavly/host/host/host.types';
import type { Workspace } from '@sheavly/workspace/workspace/workspace.service';

/** What the backend's command line and environment set for a run. */
export type CliSettings = ReturnType<typeof parseCliSettings>;

/** How the backend runs each conversation: the CLI's settings and the run settings it reads. */
export type ServedSettings = CliSettings & ReturnType<typeof parseRunEnv>;

/**
 * A profile's usable models: `switch` serves whichever is active (the profile's last, else the
 * first) and is the run's provider, keyed by model id; `choices` is what it can switch to.
 */
export type ModelSwitch = { switch: ProviderSwitch; choices: ModelChoice[] };

/**
 * What the backend decides about a run. `instructions` are the app's own extras, after the
 * generic base and the sections the run's extensions contribute (`coding`'s guidance among
 * them); `baseInstructions` replaces only the generic base (an empty string omits it) and wins
 * over an extension's replacement, which fails the run naming that extension unless the app lists
 * the reserved name (`BASE_INSTRUCTIONS_SECTION`) in `omitInstructionSections`. That option is the
 * app's alone and always wins: it leaves out the named sections the extensions contribute (the
 * names their manifests declare in `instructions`, `coding` for the coding guidance), and a name
 * nothing contributed fails the run with an `UnknownInstructionSectionError`, including a name
 * from an extension this run skipped (untrusted, or a missing service): omit only what the run's
 * extensions contribute. It is handed to the host's system prompt only; no extension reads it,
 * and a run that fails composing the prompt tells extensions only a generic reason, never the
 * names.
 */
export type BackendHarnessOptions = Pick<
  HarnessOptions,
  'instructions' | 'baseInstructions' | 'omitInstructionSections' | 'channels'
> & {
  provider: Provider;
  subAgentProvider?: Parameters<typeof createSubAgentTool>[0]['selectProvider'];
  /** Public web reading, default on; false omits it for the main run and every sub-agent. */
  webFetch?: false | Parameters<typeof createWebFetchTool>[0];
  /**
   * Search defaults to keyless Tavily here; inject another backend (a served conversation injects
   * its fallback chain) or false for all sessions.
   */
  webSearch?: false | Parameters<typeof createWebSearchTool>[0];
  /** Builds each sub-agent's summary from the provider it runs on; none means none summarize. */
  summarizeWith?: ((provider: Provider) => SummaryOptions) | undefined;
  title: string;
  /** The workspace root the agent is confined to (default: the current directory). */
  workspaceRoot?: string | undefined;
  /** The shared scratch folder the file tools may also use (the app picks it); default none. */
  scratchRoot?: string | undefined;
  /** The environment commands start from (`process.env`; secrets are scrubbed). */
  env: Environment;
  /** Which workspaces the user trusts to run `.sheavly/` hooks. */
  trustStore: TrustStore;
  /** Trust this workspace now (`--trust`), so its `.sheavly/` hooks load. */
  trustWorkspace?: boolean;
  /** What the user lets `run_command` do in this workspace (see `CommandPermissions`). */
  permissions: CommandPermissions;
  /** The user's home, for their `~/.sheavly/skills/` and `~/.agents/skills/`; omit for none. */
  home?: string | undefined;
  onModelCall?: ((request: ProviderRequest) => void) | undefined;
  /** Where the run's combined stream is kept (see `HarnessOptions.entries`); none keeps it in memory. */
  entries?: EntryStore | undefined;
  /**
   * The conversation's `shell.json`, where its agents' working root is kept so the main session
   * and its sub-agents share it. None keeps it in memory for the run.
   */
  shell?: DocumentStore | undefined;
  /**
   * Hears of a failure to restore or keep the conversation's file reads. The run goes on without
   * them: a read only ever saves a read, so losing it costs a `read_file`, never correctness.
   */
  onFileReadsProblem?: ((caughtError: unknown) => void) | undefined;
  /**
   * The conversation's complete command output store. With it `run_command` keeps every command's
   * whole output and the run gets `read_output` and `search_output`. None keeps previews only.
   */
  outputs?: OutputStore | undefined;
  /** Keeps each sub-agent's history durably (see `SubAgentOptions.keepHistory`); none keeps nothing. */
  keepAgentHistory?: Parameters<typeof createSubAgentTool>[0]['keepHistory'];
  /** Where each session's durable history log is; with it the agent gets the history tools. */
  logOf?: HistoryToolOptions['logOf'];
  /** The stored log of a conversation being reopened (see `HarnessOptions.resume`). */
  resume?: StoredLog | undefined;
  /**
   * The file locks shared with every other run of this backend, so two runs editing one file take
   * turns (see `CodingExtensionOptions.fileLocks`). Default: a set of this run's own.
   */
  fileLocks?: KeyedLocks | undefined;
  /**
   * Hears of an extension's `deactivate` that threw, at the end of the session or when another
   * extension failed to activate. The run goes on, so a failure is told, never thrown.
   */
  onExtensionProblem?: ((caughtError: unknown) => void) | undefined;
  /**
   * Extensions an embedding app adds after the built-in ones (`web`, `agents`, `coding`). They may
   * depend on those by name. A name that collides with a built-in contribution fails the run.
   */
  extensions?: readonly Extension[] | undefined;
  /**
   * The user's own settings files, already read and parsed (`readUserSettingLayers`): the global
   * layer and the bound profile's. They hold values for the settings extensions declare in their
   * manifests; a name no extension declares, or a value of another type than the default's, fails
   * the run. The workspace's `.sheavly/settings.json` is read here, since this has the workspace
   * root and the trust store.
   */
  settingLayers?: SettingFileLayers | undefined;
};

/** The layers of the user's own files; a layer is absent when its file is not there. */
export type SettingFileLayers = {
  global?: SettingLayer | undefined;
  profile?: SettingLayer | undefined;
};

/**
 * What a run's settings come to: the values in effect and where each came from (what
 * `ExtensionHost` takes as `settings` and `settingSources`), and what the workspace's file asked
 * for that did not apply: at most `MAX_IGNORED_SETTINGS` entries, and `ignoredMore` counts the
 * entries left out of the list.
 */
export type ResolvedSettings = Pick<LayeredSettings, 'values' | 'sources'> & {
  ignored: IgnoredSettingReport[];
  ignoredMore: number;
};

/** A run on the backend: the run's services, the coding workspace, and the tools and hooks it includes. */
export type BackendHarness = Harness & {
  /** The workspace the file tools are confined to (the coding extension opened it). */
  workspace: Workspace;
  /** The locks every file tool of the run takes: the set given, or the run's own. */
  fileLocks: KeyedLocks;
  /** The conversation's working root, shared by its main session and sub-agents. */
  workingRoots: WorkingRoots;
  tools: Tool[];
  hooks: Hook[];
  /** The kinds of background work the run's extensions declare. */
  workKinds: WorkKindContribution[];
  /** The settings the run's extensions declare, with their defaults and the value in effect. */
  settings: SettingInfo[];
  /**
   * What the workspace's `.sheavly/settings.json` asked for that did not apply: an entry (by name,
   * with why) or the whole file or its trust (with a fixed cause). Never a value. At most
   * `MAX_IGNORED_SETTINGS` entries; empty when nothing was ignored.
   */
  ignoredSettings: IgnoredSettingReport[];
  /** How many entries `ignoredSettings` leaves out because it is capped; 0 when none. */
  ignoredSettingsMore: number;
  /**
   * Extensions left out of the run, and why: an untrusted `project` extension, one whose
   * dependency did not activate, or one whose manifest requires services the run lacks
   * (`reason: 'service'`, with the `missing` names).
   */
  skippedExtensions: SkippedExtension[];
  /** Where the run's skills are found, for `/<skill>` and for reporting skills that didn't load. */
  skills: SkillRoots;
  /** The project's `.sheavly` hooks; `hooks` has the AGENTS.md and skills hooks first, then these. */
  projectHooks: Hook[];
  /** Whether the `.sheavly/` hooks ran: `untrusted` or `changed` says why they didn't. */
  projectTrust: ProjectTrust;
};

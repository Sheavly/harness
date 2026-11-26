import type { Provider, ProviderRequest } from '@sheavly/core/provider/provider.types';
import type { EntryStore } from '@sheavly/core/store/store.types';
import type { ApprovalRegistry } from '@sheavly/runtime/approvals/approvals.service';
import type { ConversationChannels } from '@sheavly/runtime/nodes/conversation-channels.service';
import type { NodeChannelWriter } from '@sheavly/runtime/nodes/node-channel-writer.service';
import type { TreeChannelWriter } from '@sheavly/runtime/nodes/tree-channel-writer.service';
import type { NodeRegistry } from '@sheavly/runtime/nodes/node-registry.service';
import type { NodeChannelStorage } from '@sheavly/runtime/nodes/nodes.types';
import type { SessionRegistry } from '@sheavly/runtime/sessions/sessions.service';
import type { StoredLog } from '@sheavly/runtime/sessions/sessions.types';
import type { TaskRegistry } from '@sheavly/runtime/tasks/tasks.service';
import type { SessionRef } from '@sheavly/protocol/session/session.types';
import type { SystemPrompt } from '../instructions/system-prompt.service.js';

/**
 * What any run needs, from the UI: the provider it picked and a title. Nothing here says which
 * tools or hooks a run gets; the UI composes those itself.
 */
export type HarnessOptions = {
  provider: Provider;
  /** Title of the main session (e.g. the prompt). */
  title: string;
  /** The app's own extras, after the generic core and the sections extensions contribute. */
  instructions?: string | undefined;
  /**
   * Replaces only the generic core. Omission uses the default (or an extension's replacement); an
   * empty string omits it. It wins over an extension's replacement, which is then refused.
   */
  baseInstructions?: string | undefined;
  /**
   * Instruction sections to leave out of the prompt: the names extensions declare in their
   * manifests' `instructions`, plus `BASE_INSTRUCTIONS_SECTION` (`@sheavly/extension`) for an
   * extension's replacement base. The app always wins; a name nothing contributed fails loudly
   * (`UnknownInstructionSectionError`) when the contributions are given to `systemPrompt`. Must be
   * an array of non-blank strings (or `undefined`): anything else throws an
   * `InvalidOmitInstructionSectionsError` from `createHarness`.
   */
  omitInstructionSections?: readonly string[] | undefined;
  /** Sees every model call (main session and sub-agents) before it is made. */
  onModelCall?: ((request: ProviderRequest) => void) | undefined;
  /**
   * Pass registries in when a tool needs them before the harness exists (default: new ones). A
   * `tasks` passed in has its own node registry unless it was built on one that is shared, and
   * `Harness.nodes` is always the sessions'; the default tasks share it.
   */
  tasks?: TaskRegistry;
  approvals?: ApprovalRegistry;
  /** Where the run's combined stream is kept; without it, only in memory (`SessionRegistry`). */
  entries?: EntryStore | undefined;
  /**
   * The stored log of a conversation being reopened (`readStoredLog`): the run carries on from it,
   * and its main session is the one that was stored, idle for the next prompt.
   */
  resume?: StoredLog | undefined;
  /**
   * Where each node's channel is kept, beside the combined stream: the run's agents, commands and
   * services each get a log of their own, with a failed write told once and the run going on
   * (`NodeChannelStorage`). Without it nothing is stored of them but what the stream holds.
   */
  channels?: NodeChannelStorage | undefined;
};

/**
 * The services one run shares, for the UI to build its tools and hooks on and to pass to
 * `streamAgent`. It holds no tools and no hooks: what a run includes is the UI's choice.
 */
export type Harness = {
  provider: Provider;
  /**
   * The system prompt as of now, for direct runs and, by default, conversations. On the harness
   * `createHarness` returns it is read live: the extensions' sections are in it once the app has
   * given them to `systemPrompt`, which happens after every extension has activated; an app that
   * returns a copy of the harness takes the text of that moment.
   */
  instructions: string;
  /** Where the run's system prompt is composed; an app gives it what the extensions contributed. */
  systemPrompt: SystemPrompt;
  sessions: SessionRegistry;
  mainSession: SessionRef;
  tasks: TaskRegistry;
  /**
   * Every node of the run, of any kind: the registry `sessions` and `tasks` are views of. An
   * extension never holds it (`harness/extension-no-runtime-registries` reads this type to know
   * which registries those are); it reads its own nodes through the scoped services.
   */
  nodes: NodeRegistry;
  /**
   * What stores each node's channel (`HarnessOptions.channels`), for the host to wait for its
   * writes when it closes the conversation. Absent when the run's channels are not kept. An
   * extension never holds it, like the registries: it is typed as the plain class, without
   * `| undefined`, because `harness/extension-no-runtime-registries` follows only a plain type
   * reference when it reads which modules are denied.
   */
  nodeChannels?: NodeChannelWriter;
  /**
   * What stores the conversation's tree channel, from the same `HarnessOptions.channels`: what
   * exists, what waits for the user and the conversation's notices. The host tells it the notices
   * (the queue, a storage failure), reads its `snapshot` and stops it when the conversation closes.
   * Absent when the run's channels are not kept. An extension never holds it, as with `nodeChannels`.
   */
  treeChannel?: TreeChannelWriter;
  /**
   * The channels of the conversation itself, by name, the tree among them: what the host serves a
   * subscription from, waits for and stops when the conversation closes, knowing none by its own
   * name. Absent when the run's channels are not kept. An extension never holds it, as with
   * `nodeChannels`.
   */
  conversationChannels?: ConversationChannels;
  /**
   * Where tools ask the user to approve something (run_command's risky arguments). A UI
   * subscribes, renders each `approval_requested` its own way and answers with `respond`; with no
   * subscriber they're refused.
   */
  approvals: ApprovalRegistry;
};

import type { Harness } from '../host/host.types.js';
import type { Conversation } from '../conversation/conversation.types.js';
import type { OutputStore } from '@sheavly/core/output/output.types';
import type { DocumentStore, EntryStore, HistoryLog } from '@sheavly/core/store/store.types';
import type { NodeChannelStorage, ResumedTree } from '@sheavly/runtime/nodes/nodes.types';
import type { ResumedChannel } from '@sheavly/runtime/nodes/stored-channel.types';
import type { UsageView } from '@sheavly/protocol/usage/usage.types';
import type { StoredLog } from '@sheavly/runtime/sessions/sessions.types';
import type { AgentEvent } from '@sheavly/protocol/event/event.types';
import type { HistoryMessage } from '@sheavly/protocol/history/history.types';
import type { MessageId, PromptPart } from '@sheavly/protocol/message/message.types';
import type { ModelEffort, ModelId, ModelSelection } from '@sheavly/protocol/model/model.types';
import type { PermissionMode } from '@sheavly/protocol/permission/permission.types';
import type { ProfileId } from '@sheavly/protocol/profile/profile.types';
import type {
  ConversationDetails,
  ConversationId,
  ConversationSummary,
  SendPromptRequest,
} from '@sheavly/protocol/server/server.types';
import type { SessionId } from '@sheavly/protocol/session/session.types';
import type { SkillInfo } from '@sheavly/protocol/skill/skill.types';
import type { StoredConversation } from '@sheavly/protocol/store/store.types';

/**
 * What a prompt sends once its skills ran: the text the model reads, and what the user typed
 * (`parts`) when skills ran, for the history. `unknown`: skills a prompt's parts picked that no
 * one has; the prompt isn't sent (the UI's list is stale).
 */
export type PreparedPrompt =
  { text: string; parts?: PromptPart[] | undefined } | { unknown: readonly string[] };

/**
 * What a conversation's skills are, when it has any (a coding UI's, from the workspace). The
 * host knows nothing of skills: the app that builds a conversation gives these.
 */
export type ConversationSkills = {
  /** The skills a prompt can run, for a UI's `/` menu. */
  list: (params: { signal?: AbortSignal | undefined }) => Promise<SkillInfo[]>;
  /** Turns a prompt into what to send: runs the skills its text mentions or its parts pick. */
  prepare: (params: {
    prompt: SendPromptRequest;
    signal?: AbortSignal | undefined;
  }) => Promise<PreparedPrompt>;
};

/**
 * What a conversation's run is, as the app that built it says: the workspace, the model in use
 * and the ones it can switch to, and workspace trust (`details`, which stay as they were when the
 * run was built); and how commands are treated in its workspace now (`permissionMode`, read each
 * time, since the user can change it while the conversation runs). The host only passes it on.
 */
export type ConversationRun = {
  details: () => Omit<
    ConversationDetails,
    keyof ConversationSummary | 'permissionMode' | 'workingRoot'
  >;
  permissionMode: () => Promise<PermissionMode>;
  /**
   * The folder the conversation's agents work from now, when they chose one: read each time, like
   * `permissionMode`, since they can choose another while it runs. An app with no such notion
   * leaves it out.
   */
  workingRoot?: () => Promise<ConversationDetails['workingRoot']>;
  /** Switches to the model with this id, from the next model call; false when there is none. */
  useModel: (id: ModelId, effort?: ModelEffort) => boolean | Promise<boolean>;
};

/** One live conversation the app built: its services, the conversation, and its skills if any. */
export type LiveConversation = {
  harness: Harness;
  conversation: Conversation;
  skills?: ConversationSkills | undefined;
  /**
   * What the run is, for `GET /conversations/:id`, and the model it starts on: every conversation
   * has one, since a conversation is always on a model and the host records which.
   */
  run: ConversationRun;
  /** Releases what the app opened for it (its processes, a workspace); after `close`. */
  dispose?: (() => Promise<void>) | undefined;
};

/**
 * What a start can say: history to continue from, the folder the conversation works in and the
 * profile it runs on. Both are for the app to act on (see `CreateConversation`); the host passes
 * them on and records what the run reports.
 */
export type StartConversationParams = {
  messages?: HistoryMessage[] | undefined;
  workspace?: string | undefined;
  profile?: ProfileId | undefined;
  /** The model a new conversation starts on (an id or a name): for the app to resolve and act on. */
  model?: string | undefined;
  /** The reasoning effort a new conversation starts on, for this conversation only. */
  effort?: ModelEffort | undefined;
  /** An explicitly resumed selection, not the profile's last-used preference. */
  modelSelection?: ModelSelection | undefined;
};

/**
 * Builds one conversation, as the app decides it: the provider, tools and hooks, and its skills.
 * `id` is the conversation's own, made by the host before this runs (and a stored one's when it
 * is reopened). `messages`, `workspace` and `profile` are what the start asked for, or what a
 * reopened conversation was kept with: the app decides what an absent one means, and what the run
 * reports (`ConversationRun.details`) is what the host records. `storage`, when the host keeps
 * conversations, is what the app builds the conversation on so it is kept (see
 * `ConversationStorage`). The host picks none of the rest.
 */
export type CreateConversation = (
  params: StartConversationParams & {
    id: ConversationId;
    storage?: ConversationStorage | undefined;
  },
) => Promise<LiveConversation>;

/**
 * What an app builds a kept conversation on: its stream goes to `entries` (`createHarness`'s
 * `entries`), and `keepHistory` receives prompt/follow-up previews and finished history
 * (`createConversation`'s `keepHistory`). `resume`, set when a stored conversation is reopened, is
 * the stored log to carry on from (`createHarness`'s `resume`), and the conversation is then
 * `resumed`: its session already ran its `sessionStart` hooks.
 */
export type ConversationStorage = {
  entries: EntryStore;
  /** The conversation's `shell.json`, shared by its main session and sub-agents. */
  shell: DocumentStore;
  /** The conversation's complete command output, kept with it and readable after a reopen. */
  outputs: OutputStore;
  /**
   * Where each node's channel is kept, beside the stream (`createHarness`'s `channels`). A failed
   * write is announced once as `storage_failed` and ends no run: the stream is still the record.
   */
  channels: NodeChannelStorage;
  keepHistory: (messages: readonly HistoryMessage[]) => void;
  /** A sub-agent's history so far, whole: only what is new is appended to that session's log. */
  keepAgentHistory: (params: { session: SessionId; messages: readonly HistoryMessage[] }) => void;
  /**
   * The durable history log of a session of this conversation: the main session's when `main`,
   * else sub-agent `session`'s. What the history tools search and read.
   */
  logOf: (params: { session: SessionId; main: boolean }) => HistoryLog;
  resume?: StoredLog | undefined;
};

/** What the service builds a conversation on: the storage when the host keeps anything, else none. */
export type StorageOf = { storage?: ConversationStorage };

/**
 * A prompt the conversation ran itself that failed: which conversation, and what threw. Clients
 * see the failure on the stream (`run_failed`); this is for the app to log with the conversation.
 */
export type PromptFailure = { id: ConversationId; error: unknown };

/**
 * A line waiting in a conversation's queue, with the message id it was accepted with: the id the
 * user message has when the line starts. Never stored: lines a reopen restores get new ones.
 */
export type QueuedLine = { text: string; messageId: MessageId };

/** One prompt's events, and the text and parts it sent. */
export type SentPrompt = {
  events: AsyncIterable<AgentEvent>;
  text: string;
  parts?: PromptPart[] | undefined;
};

/** What reopening a stored conversation starts from. */
export type StoredConversationState = {
  /** Its index entry as stored. */
  stored: StoredConversation;
  /** How many entries its history log holds: `messages` may be longer by the placeholders. */
  logged: number;
  /** Its history, with a placeholder for every tool call that never returned. */
  messages: HistoryMessage[];
  /** Its stream, to carry on from. */
  resume: StoredLog;
  /** Where its stored tree channel stands, for the tree writer to go on from; none stored yet. */
  resumedTree: ResumedTree | undefined;
  /** Where its stored usage channel stands, for the usage writer to go on from; none stored yet. */
  resumedUsage: ResumedChannel<UsageView> | undefined;
};

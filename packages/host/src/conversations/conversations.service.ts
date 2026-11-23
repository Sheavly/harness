import { randomUUID } from 'node:crypto';
import { now } from '@sheavly/core/clock/clock.helper';
import type { ConversationStore } from '@sheavly/core/store/store.types';
import { ConversationsError } from '../errors/conversations.errors.js';
import { ConversationKeeper } from './keeper.service.js';
import { InFlight } from './in-flight.service.js';
import { ConversationInputs } from './inputs.service.js';
import { readStoredConversation } from './stored-conversation.helper.js';
import { ModelChanges } from './model-changes.service.js';
import type {
  CreateConversation,
  LiveConversation,
  SentPrompt,
  StartConversationParams,
} from './conversations.types.js';
import { announceStorageFailure, refuseWhenStorageFailed, storageOf } from './storage.helper.js';

import { matchesSearch, matchesStored } from './conversations.utils.js';
import type { ApprovalId, ApprovalResponse } from '@sheavly/protocol/approval/approval.types';
import type { HistoryMessage } from '@sheavly/protocol/history/history.types';
import type { ModelEffort, ModelId } from '@sheavly/protocol/model/model.types';
import type {
  ConversationDetails,
  ConversationId,
  ConversationSummary,
  SendPromptRequest,
  SendPromptResponse,
} from '@sheavly/protocol/server/server.types';
import { conversationIdSchema } from '@sheavly/protocol/server/server.validator';
import type { SkillInfo } from '@sheavly/protocol/skill/skill.types';
import type { StoredConversation } from '@sheavly/protocol/store/store.types';

/**
 * The live conversations a host serves, by id: each built by the app's `create`, with the
 * operations a UI calls on them. No transport: an in-process UI calls these directly, and the
 * HTTP server only turns requests into these calls, so both behave the same.
 *
 * Given a `store`, every conversation is kept as it runs (its stream, its history and an index
 * entry), a past one can be listed (`listStored`) and reopened (`reopen`), and one whose storage
 * fails is refused its next prompt rather than carried on unrecorded.
 */
export class Conversations {
  readonly #create: CreateConversation;
  readonly #store: ConversationStore | undefined;
  readonly #live = new Map<ConversationId, LiveConversation>();
  /** Each live conversation's keeper, when the host has a store. */
  readonly #keepers = new Map<ConversationId, ConversationKeeper>();
  readonly #modelChanges = new ModelChanges();
  /** The prompt each conversation is preparing, and the lines waiting in its queue. */
  readonly #inputs: ConversationInputs;
  readonly #reopening = new InFlight<ConversationId, ConversationId>();

  constructor(params: {
    create: CreateConversation;
    store?: ConversationStore;
    /**
     * Told when a prompt the conversation runs itself (one `submit` started or queued) fails:
     * clients see it on the stream (`run_failed`), and nothing awaits it, so the app logs it.
     */
    onPromptFailure?: (error: unknown) => void;
  }) {
    this.#create = params.create;
    this.#store = params.store;
    this.#inputs = new ConversationInputs({
      store: params.store,
      storage: {
        failed: (id) => this.#storageFailureOf(id) !== undefined,
        recover: (id) => this.#recoverStorage(id),
        assertHealthy: (id) => this.#assertStorageHealthy(id),
      },
      onPromptFailure: params.onPromptFailure,
    });
  }

  /**
   * Starts a conversation, empty or continuing `messages`, and returns its id. `workspace` and
   * `profile` are for the app to act on (see `StartConversationParams`).
   */
  async start(params: StartConversationParams = {}): Promise<ConversationId> {
    const id = conversationIdSchema.parse(randomUUID());
    const keeper = this.#keeperFor(id);
    const live = await this.#create({
      id,
      messages: params.messages,
      workspace: params.workspace,
      profile: params.profile,
      model: params.model,
      effort: params.effort,
      ...(keeper && storageOf({ store: this.#store, keeper, id })),
    });

    this.#live.set(id, live);
    this.#inputs.open({ id, live, restored: [] });
    this.#begin({ id, keeper });

    return id;
  }

  /**
   * Brings a stored conversation back to life under its own id, continuing from its history:
   * its stream carries on from the last stored entry, its sessions are back, and a sub-agent
   * that was running when the process ended is `interrupted`. A conversation that is already
   * live is left as it is. `not_found` when the store has no such conversation (or the host
   * keeps none).
   */
  async reopen(id: ConversationId): Promise<ConversationId> {
    if (this.#live.has(id)) return id;

    // Two reopens at once would both log the repair placeholder: they share one.
    return this.#reopening.run({ key: id, start: () => this.#reopenStored(id) });
  }

  async #reopenStored(id: ConversationId): Promise<ConversationId> {
    if (!this.#store) {
      throw new ConversationsError({
        reason: 'not_found',
        message: `No stored conversation ${id}: this host keeps none`,
      });
    }

    const { stored, logged, messages, resume } = await readStoredConversation({
      store: this.#store,
      id,
    });
    // Parked by the queue: reopening never runs them. A broken file fails the reopen here, before
    // anything is live, rather than leave a conversation without its queue.
    const restored = await this.#inputs.stored(id);
    const keeper = this.#keeperFor(id);
    const storage = storageOf({ store: this.#store, keeper, id }).storage;
    const live = await this.#create({
      id,
      messages,
      // The conversation is reopened where it was kept: the app builds it on the same folder and
      // profile, whatever it would pick for a new one now.
      workspace: stored.workspace,
      profile: stored.profile,
      modelSelection: { modelId: stored.modelId, effort: stored.effort },
      ...(storage && { storage: { ...storage, resume } }),
    });

    this.#live.set(id, live);
    this.#inputs.open({ id, live, restored });
    keeper?.begin({ ...stored, status: 'open' });
    keeper?.resumeWith({ logged, messages });

    return id;
  }

  /**
   * The stored conversations, oldest first, as the store lists them, except that one marked open
   * which no live conversation here owns is `interrupted`: the process that kept it ended. With
   * `search`, only those whose title has it, ignoring case: the index holds no more than that, and
   * reading every history to search it would make listing as slow as the history is long.
   * `workspace` and `profile` keep only the conversations of that folder or that profile.
   */
  async listStored(
    params: {
      search?: string | undefined;
      workspace?: string | undefined;
      profile?: string | undefined;
    } = {},
  ): Promise<StoredConversation[]> {
    const stored = (await this.#store?.list()) ?? [];
    const wanted = stored.filter((each) => matchesStored({ stored: each, ...params }));

    return wanted.map((conversation) =>
      conversation.status === 'open' && !this.#live.has(conversation.id)
        ? { ...conversation, status: 'interrupted' }
        : conversation,
    );
  }

  /** The conversation `id`, or a `not_found` error. */
  get(id: ConversationId): LiveConversation {
    const live = this.#live.get(id);

    if (!live) {
      throw new ConversationsError({
        reason: 'not_found',
        message: `No conversation ${id}: it was closed, or never started`,
      });
    }

    return live;
  }

  /**
   * Every live conversation, oldest first: its main session's title and start, and whether a
   * prompt runs now. For a UI that joins a conversation another UI started.
   */
  list(): ConversationSummary[] {
    return [...this.#live.keys()].map((id) => this.#summary(id));
  }

  /**
   * What conversation `id`'s run is: its summary, and the workspace, models and trust its app
   * reports, and the permission mode its workspace has now. `not_found` when no conversation has
   * the id.
   */
  async details(id: ConversationId): Promise<ConversationDetails> {
    const { run } = this.get(id);
    const workingRoot = await run.workingRoot?.();

    return {
      ...this.#summary(id),
      ...run.details(),
      permissionMode: await run.permissionMode(),
      ...(workingRoot && { workingRoot }),
    };
  }

  /**
   * Switches conversation `id` to the model `modelId` from its next model call, or throws
   * `unknown_model`. The main session records it (`session_model`) and a kept conversation's
   * index follows, so reopening finds the model last used. Only this conversation changes: no
   * other conversation, and no sub-agent, is on a different model because of it.
   */
  async useModel(params: {
    id: ConversationId;
    modelId: ModelId;
    effort?: ModelEffort;
  }): Promise<void> {
    return this.#modelChanges.run({ id: params.id, change: () => this.#useModel(params) });
  }

  async #useModel(params: {
    id: ConversationId;
    modelId: ModelId;
    effort?: ModelEffort;
  }): Promise<void> {
    const { id, modelId } = params;
    const live = this.get(id);

    if (!(await live.run.useModel(modelId, params.effort))) {
      throw new ConversationsError({
        reason: 'unknown_model',
        message: `No model with id ${modelId} in conversation ${id}; its details list the models`,
      });
    }

    const effort = live.run.details().model.effort ?? 'medium';

    live.harness.sessions.setModel({ id: live.harness.mainSession.id, modelId, effort });
    this.#keepers.get(id)?.keepIndex({ modelId, effort });
  }

  #summary(id: ConversationId): ConversationSummary {
    const { harness, conversation } = this.get(id);
    const session = harness.sessions.get(harness.mainSession.id);

    return {
      id,
      title: session?.title ?? '',
      session: harness.mainSession.id,
      running: conversation.running,
      startedAt: session?.startedAt ?? 0,
    };
  }

  /** The keeper of conversation `id`, made on first ask; none when the host keeps nothing. */
  #keeperFor(id: ConversationId): ConversationKeeper | undefined {
    if (!this.#store) return undefined;

    const keeper =
      this.#keepers.get(id) ??
      new ConversationKeeper({
        store: this.#store,
        id,
        // Looked up when it fires: the conversation may be gone by then.
        onFailure: (failure) => announceStorageFailure({ live: this.#live.get(id), failure }),
      });

    this.#keepers.set(id, keeper);

    return keeper;
  }

  /**
   * Writes the index entry a new conversation starts with, now that its title and model exist, and
   * records the model on the main session: the first `session_model` of its stream.
   */
  #begin(params: { id: ConversationId; keeper: ConversationKeeper | undefined }): void {
    const { id, keeper } = params;
    const live = this.get(id);
    const summary = this.#summary(id);
    const { model, workspace, profile } = live.run.details();
    const effort = model.effort ?? 'medium';

    live.harness.sessions.setModel({
      id: live.harness.mainSession.id,
      modelId: model.id,
      effort,
    });
    keeper?.begin({
      id,
      title: summary.title,
      modelId: model.id,
      effort,
      workspace,
      profile,
      status: 'open',
      startedAt: summary.startedAt,
      updatedAt: now(),
    });
  }

  /**
   * The failure that stops conversation `id` taking a prompt: its history, index or stream could
   * not be stored. Undefined when storage is fine or the host keeps nothing.
   */
  #storageFailureOf(id: ConversationId) {
    return this.#keepers.get(id)?.failure ?? this.get(id).harness.sessions.storageFailure;
  }

  /**
   * Sends the next prompt: runs the skills it mentions or picks (when the conversation has
   * skills), then starts it. Its events are the caller's to iterate; the combined stream has them
   * too. Throws `session_running` while another runs, `unknown_skill` for a picked skill no one
   * has, and `storage_failed` when the conversation can no longer be kept (it would carry on
   * unrecorded), before anything starts.
   */
  async send(params: {
    id: ConversationId;
    prompt: SendPromptRequest;
    signal?: AbortSignal | undefined;
  }): Promise<SentPrompt> {
    return this.#inputs.send({ ...params, live: this.get(params.id) });
  }

  /**
   * Sends the next prompt and answers at once: it starts when nothing runs and nothing waits, or
   * waits in the conversation's queue, which starts it when what runs has ended. Either way the
   * conversation reads its run, so its entries reach clients on the stream whoever follows it.
   * Throws as `send` does for a prompt that starts, and `cannot_queue` for one that must wait but
   * cannot: one that picks skills as `parts`, one too long for the queue, or a full queue.
   */
  async submit(params: {
    id: ConversationId;
    prompt: SendPromptRequest;
  }): Promise<SendPromptResponse> {
    return this.#inputs.submit({ ...params, live: this.get(params.id) });
  }

  /** Asks conversation `id`'s running prompt to end at its completion point; false if none runs. */
  yieldPrompt(id: ConversationId): boolean {
    this.#assertStorageHealthy(id);

    return this.get(id).conversation.yieldPrompt();
  }

  /** Tries a failed write again, so a disk that has recovered does not refuse prompts for good. */
  async #recoverStorage(id: ConversationId): Promise<void> {
    if (!this.#storageFailureOf(id)) return;

    await this.#keepers.get(id)?.recover();
    await this.get(id).harness.sessions.recoverStore();
  }

  #assertStorageHealthy(id: ConversationId): void {
    refuseWhenStorageFailed({ id, failure: this.#storageFailureOf(id) });
  }

  /** Stops conversation `id`'s running prompt, if one runs; its history stays valid. */
  stop(id: ConversationId): void {
    // Also stops a run the conversation started itself, which no `send` owns.
    this.get(id).conversation.stop();
    this.#inputs.stop(id);
  }

  /** Answers a waiting approval of conversation `id`; throws for one that isn't waiting. */
  answer(params: { id: ConversationId; approval: ApprovalId; response: ApprovalResponse }): void {
    const { id, approval, response } = params;

    this.get(id).harness.approvals.respond({ id: approval, response });
  }

  /**
   * The lines waiting in conversation `id`'s queue, oldest first. Pending input is outside
   * history, model input and summaries; with a store it survives a restart, and reopening a
   * conversation never sends it. `not_found` when the conversation is not live.
   */
  async queue(id: ConversationId): Promise<string[]> {
    this.get(id);

    return this.#inputs.lines(id);
  }

  /** Replaces conversation `id`'s queued lines, whole: they start in their new order. */
  async setQueue(params: { id: ConversationId; queued: readonly string[] }): Promise<void> {
    this.get(params.id);
    await this.#inputs.replace(params);
  }

  /** The history so far, valid to continue from. */
  messages(id: ConversationId): readonly HistoryMessage[] {
    return this.get(id).conversation.messages;
  }

  /**
   * The skills a prompt in conversation `id` can run, all or those `search` matches (name or
   * description, ignoring case): none when it has no skills.
   */
  async skills(params: {
    id: ConversationId;
    search?: string | undefined;
    signal?: AbortSignal;
  }): Promise<SkillInfo[]> {
    const { id, search, signal } = params;
    const { skills } = this.get(id);

    if (!skills) return [];

    const listed = await skills.list({ ...(signal && { signal }) });

    return search ? listed.filter((skill) => matchesSearch({ skill, search })) : listed;
  }

  /**
   * Closes conversation `id`: stops its prompt, tasks and processes. It is gone after, but a host
   * with a store keeps it as `closed`, to be listed and reopened.
   */
  async close(id: ConversationId): Promise<void> {
    const live = this.get(id);
    const keeper = this.#keepers.get(id);

    // Gone first, so its queue starts nothing more; its lines stay stored with it.
    this.#live.delete(id);
    this.#inputs.close(id);
    await live.conversation.close();
    await live.dispose?.();
    keeper?.keepIndex({ status: 'closed' });
    await keeper?.flush();
    await live.harness.sessions.flushStore();
    this.#keepers.delete(id);
  }

  /** Closes every conversation: for a host shutting down. */
  async closeAll(): Promise<void> {
    await Promise.all([...this.#live.keys()].map((id) => this.close(id)));
  }
}

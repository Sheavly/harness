import { randomUUID } from 'node:crypto';
import { now } from '@sheavly/core/clock/clock.helper';
import type { StoreError } from '@sheavly/core/errors/store.errors';
import type { EntryStore } from '@sheavly/core/store/store.types';
import { checkedParent } from './child-check.helper.js';
import { EntryLog } from './entry-log.service.js';
import { restoreSessions } from './restore.helper.js';
import { releaseSubtree } from './release.helper.js';
import { ReleasedSessions } from './released-sessions.service.js';
import { SessionNodes } from './session-nodes.service.js';
import type { NodeRegistry } from '../nodes/node-registry.service.js';
import type { NodeId } from '@sheavly/protocol/node/node.types';
import type { NodeOwners } from '../tasks/tasks.types.js';
import { lineageIds, lineageOf } from './lineage-ids.helper.js';
import { missingSession } from './missing-session.helper.js';
import { readStoredLog } from './stored-log.helper.js';
import { Inboxes } from './inboxes.service.js';
import { LastTokens } from './last-tokens.service.js';
import { MessageContexts } from './message-contexts.service.js';
import { ApprovalSessions } from './approval-sessions.service.js';
import { assertCanSend, assertOpen } from './send-check.helper.js';
import { notifyAll } from './listeners.helper.js';
import { updateStream } from './update-stream.helper.js';
import { announceStorageFailure } from './storage-failure.helper.js';
import { isOpen, refOf, toEntryEvent } from './sessions.utils.js';
import { SessionError } from '../errors/sessions.errors.js';
import type {
  InboxMessage,
  RunOutcome,
  SessionId,
  SessionInfo,
  SessionRef,
  SessionUpdate,
} from '@sheavly/protocol/session/session.types';
import { isMainSession } from '@sheavly/protocol/session/session.utils';
import { sessionIdSchema } from '@sheavly/protocol/session/session.validator';
import type { CallId } from '@sheavly/protocol/message/message.types';
import type { ModelEffort, ModelId } from '@sheavly/protocol/model/model.types';
import type { AgentEvent } from '@sheavly/protocol/event/event.types';
import type { ApprovalUpdate } from '@sheavly/protocol/approval/approval.types';
import type { StreamEntry } from '@sheavly/protocol/stream/stream.types';
import type { TaskUpdate } from '@sheavly/protocol/task/task.types';
import type { QueueUpdate } from '@sheavly/protocol/queue/queue.types';
import type { TokenUsage } from '@sheavly/protocol/usage/usage.types';
import type { EntryFilter, QueuedNotice, SessionMessage, StoredLog } from './sessions.types.js';

type Listener = (update: SessionUpdate) => void;

/**
 * Every session of one main run, as a tree: the main session, its sub-agents and theirs. A
 * sub-agent can only start under a running session that is in this registry, so none floats free,
 * and never deeper than `MAX_SESSION_DEPTH`. Status reports and endings are pushed to listeners,
 * and streamed as server-sent events for a UI (`stream()`).
 *
 * It also orders the whole tree's activity: every session update and every event a session's
 * loop publishes (`publish`) becomes one `StreamEntry`, numbered 0, 1, 2, ... across all sessions
 * in the order it happened, for a UI following every session at once (`subscribeEntries`).
 */
export class SessionRegistry {
  /** Each session is an agent node: its state and links live in the node registry. */
  readonly #sessions: SessionNodes;
  #listeners = new Set<Listener>();
  readonly #entries: EntryLog;
  /** The session each waiting approval belongs to, so its answer lands in the same place. */
  readonly #approvalSessions = new ApprovalSessions();
  #inboxes = new Inboxes();
  #lastTokens: LastTokens;
  readonly #messageContexts: MessageContexts;
  /** What was released, in process or before a reopen: a released session is not a live one. */
  readonly #released = new ReleasedSessions();

  /**
   * Only the newest entries of the combined stream stay in memory (`EntryLog`); with a `store`
   * they are also written to it, and a replay reads the older ones from there. With `resume` (read from the same
   * store by `readStoredLog`), it carries on a stored conversation: numbering continues, its
   * sessions are back, and `restoredMain()` is the main session, idle for the next prompt. A
   * sub-agent that was still open when the process died is `interrupted`: it is not run again.
   */
  constructor(options: { store?: EntryStore; resume?: StoredLog; nodes?: NodeRegistry } = {}) {
    const { store, resume, nodes } = options;

    this.#sessions = new SessionNodes(nodes);
    this.#lastTokens = new LastTokens(resume?.lastTokens);
    this.#messageContexts = new MessageContexts(resume?.messageContexts);
    this.#entries = new EntryLog({
      lineage: (id) => lineageIds({ id, sessions: this.#sessions, released: this.#released }),
      ...(store && { store }),
      ...(resume && { resume }),
      onFailure: (failure) => announceStorageFailure({ sessions: this, failure }),
    });

    if (resume) {
      restoreSessions({
        stored: resume.sessions,
        released: { into: this.#released, sessions: resume.released ?? [] },
        sessions: this.#sessions,
        emit: (update) => this.#emit(update),
      });
    }
  }

  /**
   * Reads a stored conversation's entries once, in order, for `new SessionRegistry({ store,
   * resume })` to carry on from. Throws a `StoreError` when the entries have a gap.
   */
  static readonly readStoredLog: (store: EntryStore) => Promise<StoredLog> = readStoredLog;

  /** The registry every node of this conversation is in: sessions, and the tasks that share it. */
  get nodes(): NodeRegistry {
    return this.#sessions.registry;
  }

  /** The node a session is, or none for an unknown or released session. */
  nodeIdOf(id: SessionId): NodeId | undefined {
    return this.#sessions.nodeIdOf(id);
  }

  /** What a `TaskRegistry` needs to share these nodes: `new TaskRegistry(sessions.nodeOwners)`. */
  get nodeOwners(): NodeOwners {
    return { nodes: this.nodes, nodeIdOf: (id) => this.nodeIdOf(id) };
  }

  /** The first failed write to the store, if any: the conversation should stop, not go on unrecorded. */
  get storageFailure(): StoreError | undefined {
    return this.#entries.failure;
  }

  /** Tries a failed store write again, with the entries behind it; see `storageFailure`. */
  readonly recoverStore = (): Promise<void> => this.#entries.recover();

  /** Resolves once every entry so far is in the store (or a write has failed). */
  readonly flushStore = (): Promise<void> => this.#entries.flush();

  /**
   * The `seq` the next entry of the combined stream will get. A subscriber that reads it before it
   * subscribes knows which entries are history (below it) and which are live (at or above).
   */
  readonly nextSeq = (): number => this.#entries.next;

  /** How many entries of the combined stream are in memory (the newest few, with a store). */
  get retainedEntries(): number {
    return this.#entries.retained;
  }

  /** Associates activity with this user message; existing children keep their own origin. */
  setMessage(context: SessionMessage): void {
    this.#require(context.sessionId);
    this.#messageContexts.set(context);
  }

  /**
   * The user message session `id`'s activity is associated with now (`setMessage`): the prompt it
   * answers. None before a prompt, and for a sub-agent started before one. Unknown ids read as none.
   */
  readonly messageOf = (id: SessionId) => this.#messageContexts.get(id);

  /** Starts the main session (depth 1). */
  startMain(params: { title: string; id?: SessionId }): SessionRef {
    const id = params.id ?? sessionIdSchema.parse(randomUUID());

    return this.#add({ id, rootId: id, depth: 1, title: params.title });
  }

  /**
   * Starts a sub-agent session under `parentId`, which `startedByCall` (a call in the parent's
   * history) started. Throws if the parent is unknown or ended, or at the depth cap.
   */
  startChild(params: { parentId: SessionId; startedByCall: CallId; title: string }): SessionRef {
    const { parentId, startedByCall, title } = params;
    const parent = checkedParent({ parentId, parent: this.#sessions.get(parentId) });

    return this.#add({
      id: sessionIdSchema.parse(randomUUID()),
      parentId,
      startedByCall,
      rootId: parent.rootId,
      depth: parent.depth + 1,
      title,
    });
  }

  /**
   * Records the model session `id` runs on, at its start and at each switch, and announces it
   * (`session_model`). It is that session's only: a sub-agent's model never changes the main
   * session's. Setting the model it already has is not announced again. Throws for an unknown
   * session, and for one that has ended: its model is the one it ran on.
   */
  setModel(params: { id: SessionId; modelId: ModelId; effort?: ModelEffort }): void {
    const { id, modelId, effort } = params;
    const session = this.#require(id);

    assertOpen({ session, consequence: 'its model is the one it ran on' });

    if (!this.#sessions.setModel({ id, modelId, effort })) return;

    this.#emit({
      type: 'session_model',
      session: this.#require(id),
      modelId,
      ...(effort && { effort }),
    });
  }

  /** A sub-agent's own status report ("editing core package"). Ignored once the session ended. */
  report(params: { id: SessionId; status: string }): void {
    const session = this.#require(params.id);

    if (session.state !== 'running') return;

    this.#sessions.report(params);
    this.#emit({ type: 'session_status', session: this.#require(params.id) });
  }

  /**
   * Ends a running or idle session for good, with how its last run finished. Ending twice keeps
   * the first ending.
   */
  end(params: { id: SessionId; state: RunOutcome }): void {
    const session = this.#require(params.id);

    if (!isOpen(session.state)) return;

    this.#sessions.end(params);
    this.#emit({ type: 'session_ended', session: this.#require(params.id) });
    this.#inboxes.wake(params.id); // nobody waits on an ended session's inbox
  }

  /**
   * A conversation's prompt finished, and the session stays open for the next: `outcome` is how
   * that run ended. Only a running session goes idle; otherwise this does nothing.
   */
  idle(params: { id: SessionId; outcome: RunOutcome }): void {
    const session = this.#require(params.id);

    if (session.state !== 'running') return;

    this.#sessions.idle(params);
    this.#emit({ type: 'session_idle', session: this.#require(params.id) });
  }

  /** The next prompt of a conversation starts: an idle session runs again. Throws otherwise. */
  resume(id: SessionId): void {
    const session = this.#require(id);

    if (session.state !== 'idle') {
      throw new SessionError({
        reason: session.state === 'running' ? 'session_running' : 'session_ended',
        sessionId: id,
        message: `Session ${id} is ${session.state}; only an idle session can take its next prompt`,
      });
    }

    this.#sessions.resume(id);
    this.#emit({ type: 'session_resumed', session: this.#require(id) });
  }

  /**
   * Queues a message for a running or idle session; its loop delivers it at the next model call
   * (an idle session's, at its next prompt), without stopping anything. `from` is `'user'`, or a session id, which must be an ancestor of the
   * target: a session steers only its own sub-agents (and theirs). Throws otherwise, and
   * `inbox_full` when others wait and the inbox holds `MAX_QUEUED_MESSAGES` messages, or this one
   * would take them past `MAX_QUEUED_MESSAGE_CHARS` characters (see `Inboxes.add`).
   */
  send(params: { id: SessionId; content: string; from: InboxMessage['from'] }): void {
    const { id, content, from } = params;
    const session = this.#require(id);

    assertCanSend({ session, from, lineage: this.lineage(id) });

    const message: InboxMessage = { from, content, sentAt: now() };

    // Queued first: a full inbox throws, and no `session_message` is told for what was refused.
    this.#inboxes.add({ id, message });
    this.#emit({ type: 'session_message', session, message });
  }

  /**
   * Queues an extension's notice, already checked by its host, for a running or idle session; its
   * loop publishes it, in order, at the next turn (an idle session's, at its next prompt). Throws
   * `session_ended` for a session that has ended, never drops it silently: the extension that
   * emitted it learns its notice went nowhere. Throws for an unknown or released session too,
   * `invalid_notice` for a notice the protocol's schema refuses (checked whatever the caller did,
   * since history reads it back) and `outbox_full` past `MAX_QUEUED_NOTICES`.
   */
  queueNotice(params: { id: SessionId; notice: QueuedNotice }): void {
    this.#inboxes.addNotice({ session: this.#require(params.id), notice: params.notice });
  }

  /** Removes and returns the session's queued extension notices, oldest first. */
  takeNotices(id: SessionId): QueuedNotice[] {
    return this.#inboxes.takeNotices(id);
  }

  /**
   * Forgets an ended session and every sub-agent under it, with their queued messages, last
   * tokens and message ids, and returns how many sessions went. Throws `session_running` if any
   * of them is still open. Entries already in the combined stream stay, and a filter on an
   * ancestor's subtree still matches them. Each session that went is announced
   * (`session_released`), and a later `publish` for it throws `session_released`.
   */
  release(id: SessionId): number {
    this.#require(id);

    const released = releaseSubtree({
      id,
      sessions: this.#sessions,
      holders: [this.#inboxes, this.#lastTokens, this.#messageContexts, this.#approvalSessions],
    });

    for (const session of released) {
      this.#released.record(session);
      this.#emit({ type: 'session_released', session });
    }

    return released.length;
  }

  /**
   * For the loop, once a sub-agent's report is delivered: releases the ended sub-agent `id` and
   * what it started, and returns whether it did. Refuses nothing by throwing: an open session
   * under it (a grandchild still being cancelled), a main session and an id already released or
   * unknown are left alone. The loop does not retry: it delivers a report once.
   */
  releaseAgent(id: SessionId): boolean {
    const session = this.#sessions.get(id);

    if (!session || !('parentId' in session)) return false;

    if (this.#sessions.openBelow(id)) return false;

    this.release(id);

    return true;
  }

  /** Whether `id` was a session of this registry that has since been released. */
  isReleased(id: SessionId): boolean {
    return this.#released.has(id);
  }

  /**
   * The sessions released so far with when each started. Their stored history stays readable, so
   * what searches a conversation's history asks for them here, and only for these two facts.
   */
  releasedStarts(): { id: SessionId; startedAt: number }[] {
    return this.#released.starts();
  }

  /** Removes and returns the session's queued messages, oldest first. */
  takeMessages(id: SessionId): InboxMessage[] {
    return this.#inboxes.take(id);
  }

  hasMessages(id: SessionId): boolean {
    return this.#inboxes.has(id);
  }

  /**
   * Resolves when a message arrives for the session (or it ends). For a loop waiting idle.
   * Aborting `signal` drops the wait, for a caller that stopped waiting.
   */
  nextMessage(id: SessionId, signal?: AbortSignal): Promise<void> {
    return this.#inboxes.next(id, signal);
  }

  /** How many callers wait on the session's inbox: none is left behind by one that gave up. */
  inboxWaiters(id: SessionId): number {
    return this.#inboxes.waiting(id);
  }

  get(id: SessionId): SessionInfo | undefined {
    return this.#sessions.get(id);
  }

  list(): SessionInfo[] {
    return this.#sessions.list();
  }

  /** The sessions `id` started directly. */
  children(id: SessionId): SessionInfo[] {
    return this.list().filter((session) => 'parentId' in session && session.parentId === id);
  }

  /** `id` and every ancestor, up to the main session (last). */
  lineage(id: SessionId): SessionInfo[] {
    return lineageOf({ id, sessions: this.#sessions });
  }

  /** Calls `listener` for every update from now on. Returns a function that stops it. */
  subscribe(listener: Listener): () => void {
    this.#listeners.add(listener);

    return () => {
      this.#listeners.delete(listener);
    };
  }

  /**
   * Adds an event of session `sessionId`'s loop to the combined stream, in the order published.
   * The loop publishes each event as it releases it, so a session's events keep their own order.
   * `done` goes in without its `messages` (`toEntryEvent`): the stream is kept for replay.
   */
  publish(params: { sessionId: SessionId; event: AgentEvent }): void {
    const { sessionId } = params;
    const event = toEntryEvent(params.event);

    this.#require(sessionId);
    this.#lastTokens.observe({ sessionId, event });
    this.#addEntry((seq) => ({ seq, sessionId, kind: 'event', event }));
  }

  /**
   * What the session's last model call reported, for its loop to tell the agent how full its
   * context is. It survives the session's runs (a conversation's next prompt) and a restore, and
   * is none before a call that reported usage.
   */
  lastTokens(id: SessionId): TokenUsage | undefined {
    return this.#lastTokens.get(id);
  }

  /**
   * Clears the session's last reported tokens, for when the history they described was replaced
   * (a summary): the next model call reports its own. Held in memory only, so a conversation
   * reopened before that call reads the stored, older numbers.
   */
  forgetLastTokens(id: SessionId): void {
    this.#require(id);
    this.#lastTokens.forget(id);
  }

  /**
   * Adds an approval update to the combined stream, under the session whose tool asked: its
   * `sessionId`, or the first main session for a call outside the loop. The answer (or the cancel)
   * goes under the same session as its request, so a session's filter sees both.
   */
  publishApproval(update: ApprovalUpdate): void {
    const main = () => this.#sessions.firstMainId();
    const sessionId = this.#approvalSessions.keepSession({ update, main });

    this.#require(sessionId);
    this.#addEntry((seq) => ({ seq, sessionId, kind: 'approval', update }));
  }

  /**
   * Adds a background task's start or end to the combined stream, under the session whose tool
   * started it, or the first main session for one started outside the loop.
   */
  publishTask(params: { update: TaskUpdate; sessionId?: SessionId | undefined }): void {
    const { update } = params;
    const sessionId = params.sessionId ?? this.#sessions.firstMainId();

    this.#require(sessionId);
    this.#addEntry((seq) => ({ seq, sessionId, kind: 'task', update }));
  }

  /**
   * Adds a change to a conversation's queued lines to the combined stream, under its main session
   * `sessionId`: in order with the runs, so a line that starts comes before its run's entries.
   */
  publishQueue(params: { sessionId: SessionId; update: QueueUpdate }): void {
    const { sessionId, update } = params;

    this.#require(sessionId);
    this.#addEntry((seq) => ({ seq, sessionId, kind: 'queue', update }));
  }

  /**
   * Calls `listener` for the entries of the combined stream `filter` picks (every session's, one
   * session's, or a session's and its sub-agents'), sub-agents included, in one `seq` order;
   * with `replay`, from the run's start. Each entry is frozen. Returns a function that stops it.
   * With a store, a replay reaching past the entries in memory is delivered a moment later; if
   * the store can't give them all, `onError` hears of it and no more is delivered.
   */
  subscribeEntries(
    listener: (entry: StreamEntry) => void,
    filter?: EntryFilter,
    onError?: (error: StoreError) => void,
  ): () => void {
    return this.#entries.subscribe({
      listener,
      ...(filter && { filter }),
      ...(onError && { onError }),
    });
  }

  /**
   * Updates as server-sent events (`text/event-stream`), for an HTTP response body:
   * `new Response(sessions.stream({ signal }), { headers: { 'content-type': 'text/event-stream' } })`.
   * Starts with every known session (so a late UI catches up), then streams live until `signal`.
   */
  stream(params: { signal?: AbortSignal } = {}): ReadableStream<Uint8Array> {
    return updateStream({ sessions: this, ...params });
  }

  #add(params: SessionRef & { title: string }): SessionRef {
    const session = this.#sessions.add(params);

    if ('parentId' in session) {
      this.#messageContexts.inherit({ sessionId: session.id, parentId: session.parentId });
    }

    this.#emit({ type: 'session_started', session });

    return refOf(session);
  }

  /**
   * The main session of a restored conversation: the one a prompt resumes. Undefined for a
   * registry that was not restored.
   */
  restoredMain(): SessionRef | undefined {
    const main = this.#sessions.list().find(isMainSession);

    return main && refOf(main);
  }

  #require(id: SessionId): SessionInfo {
    const session = this.#sessions.get(id);

    if (!session) throw missingSession({ id, released: this.#released });

    return session;
  }

  #emit(update: SessionUpdate): void {
    const snapshot = { ...update, session: { ...update.session } };

    notifyAll({ listeners: this.#listeners, value: snapshot });
    this.#addEntry((seq) => ({ seq, sessionId: snapshot.session.id, kind: 'update', update }));
  }

  #addEntry(build: (seq: number) => Omit<StreamEntry, 'at'>): void {
    this.#entries.add((seq) => this.#messageContexts.annotate(build(seq)));
  }
}

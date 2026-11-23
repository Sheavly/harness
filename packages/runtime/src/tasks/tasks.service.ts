/** Background work and completion notices shared by tools and session-scoped loops. */
import { now } from '@sheavly/core/clock/clock.helper';
import { NodeRegistry } from '../nodes/node-registry.service.js';
import { endTaskNode, newTaskEntry, releaseTaskNode } from './task-nodes.helper.js';
import type {
  Delivery,
  Entry,
  NodeOwners,
  StartTask,
  TaskDelivery,
  TaskObserver,
  TaskResult,
} from './tasks.types.js';
import type { CallId } from '@sheavly/protocol/message/message.types';
import type { RunningTask } from '@sheavly/protocol/notice/notice.types';
import type { SessionId } from '@sheavly/protocol/session/session.types';
import type { TaskId, TaskInfo, TaskStatus, TaskUpdate } from '@sheavly/protocol/task/task.types';
import { taskIdSchema } from '@sheavly/protocol/task/task.validator';
import { TaskError } from '../errors/tasks.errors.js';
import { groupMemberError, unknownTaskError } from './group-member.helper.js';
import { ReleasedAgents } from './released-agents.service.js';
import { SettleWaiters } from './settle-waiters.service.js';
import { runningTasksOf } from './running-tasks.helper.js';
import { runTask } from './task-run.helper.js';
import { WORK_IS_SUB_AGENT } from './tasks.constants.js';
import { isIssued, runningInfo, settledStatus } from './tasks.utils.js';
import { isFiniteKind } from './work.utils.js';

/**
 * Background work, each task a node of the conversation's node registry: a command, a service, or
 * a sub-agent (the agent node its session already is). The registry owns the task's own
 * bookkeeping (output, groups, deliveries); the node owns its lifecycle, so a task ends through the
 * node machine. With `owners` (a `SessionRegistry`'s `nodes` and `nodeIdOf`) its nodes sit under the
 * node of the session that started them; with none it has a registry of its own and they sit at
 * the root.
 */
export class TaskRegistry {
  #tasks = new Map<TaskId, Entry>();
  #nextId = 1;
  /** Notices in the order they became ready, not the order tasks started. */
  #ready: Delivery[] = [];
  #observers = new Set<TaskObserver>();
  readonly #releasedAgents = new ReleasedAgents();
  readonly #settleWaiters = new SettleWaiters();
  readonly #owners: NodeOwners;

  constructor(owners?: NodeOwners) {
    this.#owners = owners ?? { nodes: new NodeRegistry(), nodeIdOf: () => undefined };
  }

  /** The registry every node of this conversation is in. */
  get nodes(): NodeRegistry {
    return this.#owners.nodes;
  }

  start({
    command,
    description,
    callId,
    sessionId,
    agentSessionId,
    backgroundKind: kind = 'task',
    capture,
    run,
  }: StartTask): TaskInfo {
    const id = taskIdSchema.parse(`t${this.#nextId++}`);
    const controller = new AbortController();
    const info = runningInfo({ id, callId, command, description, kind, startedAt: now() });
    const entry = newTaskEntry({
      owners: this.#owners,
      entries: this.#tasks.values(),
      info,
      controller,
      sessionId,
      agentSessionId,
    });

    entry.settled = runTask({
      info,
      signal: controller.signal,
      capture,
      run,
      settle: (ended) => {
        this.#settle({ entry, ...ended });
      },
    });
    this.#tasks.set(id, entry);
    this.#notify({ entry, type: 'task_started' });

    return { ...info };
  }

  /** Observes every start/end immediately, including held and cancelled tasks. */
  observe(observer: TaskObserver): () => void {
    this.#observers.add(observer);

    return () => {
      this.#observers.delete(observer);
    };
  }

  get(id: TaskId): TaskInfo | undefined {
    const entry = this.#tasks.get(id);

    return entry && { ...entry.info };
  }

  /** Whole report, undefined for an unknown/running task or one that returned no report. */
  report(id: TaskId): string | undefined {
    return this.#tasks.get(id)?.report;
  }

  /** Every task, or with a session only the ones it owns and the ones with no owner. */
  list(sessionId?: SessionId): TaskInfo[] {
    return [...this.#tasks.values()]
      .filter((entry) => this.#owns({ entry, sessionId }))
      .map((e) => ({ ...e.info }));
  }

  /** `get` as a session: a task another session owns reads as unknown, as in `group`. */
  getOwned(params: { id: TaskId; sessionId: SessionId | undefined }): TaskInfo | undefined {
    return this.list(params.sessionId).find((task) => task.id === params.id);
  }

  /**
   * Fresh metadata-only snapshots of every compatible running task, including services, in start
   * order. Does not consume deliveries or bound text/count. Generic tasks are visible to all
   * sessions; groups use their first requested ID. If any member belongs to another session,
   * hides the shared group ID and reason while retaining compatible tasks with their descriptions.
   */
  runningTasks(sessionId?: SessionId): RunningTask[] {
    return runningTasksOf({
      entries: this.#tasks.values(),
      owns: (entry) => this.#owns({ entry, sessionId }),
      ownsDelivery: (delivery) => this.#ownsDelivery({ delivery, sessionId }),
    });
  }

  /** The task a tool call started; with a session, only among the ones it owns. */
  byCallId(params: { callId: CallId; sessionId?: SessionId }): TaskInfo | undefined {
    return this.list(params.sessionId).find((t) => t.callId === params.callId);
  }

  get runningCount(): number {
    return this.list().filter((t) => t.status === 'running').length;
  }

  /**
   * Holds members for one notice when the last settles, in requested ID order. Returns immediately.
   * Throws TaskError atomically for empty, duplicate, unknown, already grouped, unowned, service or
   * already delivered IDs.
   * A supplied session also accepts generic tasks without an owner.
   */
  group(params: { ids: TaskId[]; reason: string; sessionId?: SessionId }): void {
    const { ids, reason, sessionId } = params;

    if (ids.length === 0) {
      throw new TaskError({ reason: 'empty_group', message: 'A task group must contain IDs' });
    }

    const seen = new Set<TaskId>();

    for (const id of ids) {
      this.#validateGroupMember({ id, seen, sessionId });
      seen.add(id);
    }

    const group: Delivery = { ids: [...ids], reason, delivered: false };

    for (const id of ids) {
      const entry = this.#entry(id);

      entry.group = group;
      delete entry.delivery;
      entry.info.reason = reason;
    }

    this.#ready = this.#ready.filter((delivery) => !delivery.ids.some((id) => seen.has(id)));
    if (this.#enqueueSettledGroup(group)) this.#wakeWaiters();
  }

  /** Ready notices, oldest first, consumed once. Scoped callers cannot consume another owner's. */
  takeDeliveries(sessionId?: SessionId): TaskDelivery[] {
    const ready = this.#ready.filter((delivery) => this.#ownsDelivery({ delivery, sessionId }));
    const taken = new Set(ready);

    this.#ready = this.#ready.filter((delivery) => !taken.has(delivery));

    return ready.map((delivery) => {
      delivery.delivered = true;

      return {
        tasks: delivery.ids.map((id) => ({ ...this.#entry(id).info })),
        ...(delivery.reason !== undefined && { reason: delivery.reason }),
      };
    });
  }

  hasDeliveries(sessionId?: SessionId): boolean {
    return this.#ready.some((delivery) => this.#ownsDelivery({ delivery, sessionId }));
  }

  /** Finite work still running, or completed notices still awaiting delivery; services may run on. */
  hasPendingTasks(sessionId?: SessionId): boolean {
    return (
      this.hasDeliveries(sessionId) ||
      [...this.#tasks.values()].some(
        (entry) =>
          this.#owns({ entry, sessionId }) &&
          isFiniteKind(entry.backgroundKind) &&
          (entry.info.status === 'running' ||
            (entry.group !== undefined &&
              !entry.group.delivered &&
              this.#ownsDelivery({ delivery: entry.group, sessionId }))),
      )
    );
  }

  /**
   * Running members of groups whose notice is not yet delivered: the tasks a run holds for when it
   * waits on `await_tasks`. Ungrouped tasks do not count.
   */
  groupedPendingCount(sessionId?: SessionId): number {
    return [...this.#tasks.values()].filter(
      ({ info, group }) =>
        info.status === 'running' &&
        group !== undefined &&
        !group.delivered &&
        this.#ownsDelivery({ delivery: group, sessionId }),
    ).length;
  }

  /** Whether grouped work is still running: what `await_tasks` holds a main session open for. */
  hasAwaitedTasks(sessionId?: SessionId): boolean {
    return this.groupedPendingCount(sessionId) > 0;
  }

  /**
   * Whether a ready notice reports finite work, so an idle session should be woken for it. A
   * service's own end is reported at the next model call and never starts one.
   */
  hasWakingDeliveries(sessionId?: SessionId): boolean {
    return this.#ready.some(
      (delivery) =>
        this.#ownsDelivery({ delivery, sessionId }) &&
        delivery.ids.some((id) => isFiniteKind(this.#entry(id).backgroundKind)),
    );
  }

  /** Forgets settled, delivered tasks or silent singles. Held group members cannot be released. */
  release(id: TaskId): boolean {
    const entry = this.#tasks.get(id);

    if (!entry || entry.info.status === 'running' || (entry.group && !entry.group.delivered)) {
      return false;
    }

    if (this.#ready.some((delivery) => delivery.ids.includes(id))) return false;

    releaseTaskNode({ nodes: this.nodes, entry });

    // The session of a sub-agent is released by its owner (the loop), not here: it is left to be
    // asked for, so a task released without a delivery (a silent cancel) still lets it go.
    if (entry.agentSessionId !== undefined) {
      this.#releasedAgents.add({ agent: entry.agentSessionId, owner: entry.sessionId });
    }

    return this.#tasks.delete(id);
  }

  /**
   * The sub-agent session a task runs, when `start` was told which. Gone with the task: ask before
   * `release`.
   */
  agentSessionOf(id: TaskId): SessionId | undefined {
    const entry = this.#tasks.get(id);

    // Only sub-agent work runs a session: a command that was told one is not given a card for it.
    return entry && WORK_IS_SUB_AGENT[entry.info.kind] ? entry.agentSessionId : undefined;
  }

  /**
   * The sub-agent sessions of the tasks `owner` had released since it last asked, each once, for
   * the owner to release as well (see `ReleasedAgents`).
   */
  takeReleasedAgents(owner: SessionId): SessionId[] {
    return this.#releasedAgents.take(owner);
  }

  /**
   * Releases every task `release` would, and returns how many went. A supplied session releases
   * only the tasks it owns or that have no owner, so one session's turn boundary never drops a
   * task another session has yet to read.
   */
  releaseFinished(sessionId?: SessionId): number {
    return [...this.#tasks.entries()]
      .filter(([, entry]) => this.#owns({ entry, sessionId }))
      .filter(([id]) => this.release(id)).length;
  }

  /**
   * Whether `id` was handed out by this registry and has since been released. Ids are sequential
   * and never reused, so this needs no record of released tasks; a string that is not a canonical
   * id (`t0`, `t01`, `x1`) was never handed out.
   */
  isReleased(id: TaskId): boolean {
    return isIssued({ id, nextId: this.#nextId }) && !this.#tasks.has(id);
  }

  /** Stops a task and waits for it to exit. Cancelled group members remain part of their notice. */
  async cancel(id: TaskId): Promise<TaskInfo | undefined> {
    const entry = this.#tasks.get(id);

    if (!entry) return undefined;

    if (entry.info.status === 'running') {
      entry.silent = true;
      entry.controller.abort();
      await entry.settled;
    }

    return { ...entry.info };
  }

  /** Stops everything still running (main run shutdown). */
  async cancelAll(): Promise<void> {
    await Promise.all(this.list().map((t) => this.cancel(t.id)));
  }

  /** Cancels exact session ownership only; child signals handle descendant cancellation. */
  async cancelSession(sessionId: SessionId): Promise<void> {
    const owned = [...this.#tasks.values()].filter((entry) => entry.sessionId === sessionId);

    await Promise.all(owned.map((entry) => this.cancel(entry.info.id)));
  }

  /** Compatibility view: flattens and consumes ready deliveries, never held members. */
  takeUnreported(): TaskInfo[] {
    return this.takeDeliveries().flatMap((delivery) => delivery.tasks);
  }

  get hasUnreported(): boolean {
    return this.hasDeliveries();
  }

  /** Resolves on the next settlement; aborting drops the wait and resolves it. */
  nextSettled(signal?: AbortSignal): Promise<void> {
    return this.#settleWaiters.next(signal);
  }

  get settleWaiters(): number {
    return this.#settleWaiters.count;
  }

  #entry(id: TaskId): Entry {
    const entry = this.#tasks.get(id);

    if (!entry) throw unknownTaskError(id);

    return entry;
  }

  #owns(params: { entry: Entry; sessionId: SessionId | undefined }): boolean {
    const { entry, sessionId } = params;

    return (
      sessionId === undefined || entry.sessionId === undefined || entry.sessionId === sessionId
    );
  }

  #ownsDelivery(params: { delivery: Delivery; sessionId: SessionId | undefined }): boolean {
    const { delivery, sessionId } = params;

    return delivery.ids.every((id) => this.#owns({ entry: this.#entry(id), sessionId }));
  }

  #validateGroupMember(params: {
    id: TaskId;
    seen: Set<TaskId>;
    sessionId: SessionId | undefined;
  }) {
    const { id, seen, sessionId } = params;

    // A released id has no entry, so `#entry` refuses it like one that never existed.
    const entry = this.#entry(id);
    const error = groupMemberError({
      id,
      duplicate: seen.has(id),
      grouped: entry.group !== undefined,
      service: !isFiniteKind(entry.backgroundKind),
      owned: this.#owns({ entry, sessionId }),
      delivered: entry.delivery?.delivered === true,
    });

    if (error) throw error;
  }

  #enqueueSettledGroup(group: Delivery): boolean {
    if (!group.ids.every((id) => this.#entry(id).info.status !== 'running')) return false;

    this.#ready.push(group);

    return true;
  }

  #wakeWaiters(): void {
    this.#settleWaiters.wake();
  }

  #settle(params: { entry: Entry; status: TaskStatus; result: TaskResult }) {
    const { entry, status, result } = params;
    const { info } = entry;

    info.status = settledStatus({ status, aborted: entry.controller.signal.aborted });
    info.endedAt = now();
    if ('exitCode' in result) info.exitCode = result.exitCode;
    if (result.error) info.error = result.error;
    entry.report = result.report;
    endTaskNode({ nodes: this.nodes, entry });

    if (entry.group) this.#enqueueSettledGroup(entry.group);

    if (!entry.group && !entry.silent) {
      entry.delivery = { ids: [info.id], delivered: false };
      this.#ready.push(entry.delivery);
    }

    this.#notify({ entry, type: 'task_ended' });
    this.#wakeWaiters();
  }

  #notify(params: { entry: Entry; type: TaskUpdate['type'] }) {
    const { entry, type } = params;

    for (const observer of this.#observers) {
      observer({
        update: { type, task: { ...entry.info } },
        ...(entry.sessionId && { sessionId: entry.sessionId }),
      });
    }
  }
}

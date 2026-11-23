import type { ModelEffort, ModelId } from '@sheavly/protocol/model/model.types';
import type { NodeId } from '@sheavly/protocol/node/node.types';
import type {
  RunOutcome,
  SessionId,
  SessionInfo,
  SessionRef,
} from '@sheavly/protocol/session/session.types';
import { isMainSession } from '@sheavly/protocol/session/session.utils';
import { sessionIdSchema } from '@sheavly/protocol/session/session.validator';
import { SessionError } from '../errors/sessions.errors.js';
import { NodeRegistry } from '../nodes/node-registry.service.js';
import type { NodeRecord } from '../nodes/nodes.types.js';
import { restoredFieldsOf, sessionOutcomeOf, sessionStateOf } from './session-nodes.utils.js';

/**
 * The sessions of a conversation, as `SessionInfo` views of the agent nodes of a `NodeRegistry`.
 * A session's state, parent, title, model, times and outcome live in its node, so the node
 * machine is the one that moves it; this keeps the session id each node answers to, and builds the
 * `SessionInfo` a UI and the loop have always read from it. Every method hands out copies.
 */
export class SessionNodes {
  readonly registry: NodeRegistry;
  readonly #nodeOf = new Map<SessionId, NodeId>();
  readonly #sessionOf = new Map<NodeId, SessionId>();

  constructor(registry: NodeRegistry = new NodeRegistry()) {
    this.registry = registry;
  }

  /** The node a session is, or none for an id this registry never had or has released. */
  nodeIdOf(id: SessionId): NodeId | undefined {
    return this.#nodeOf.get(id);
  }

  get(id: SessionId): SessionInfo | undefined {
    const nodeId = this.#nodeOf.get(id);
    const node = nodeId === undefined ? undefined : this.registry.get(nodeId);

    return node && this.#viewOf(node);
  }

  /** Every session, in the order they started: a parent before the sessions it started. */
  list(): SessionInfo[] {
    return this.registry
      .list()
      .filter((node) => this.#sessionOf.has(node.id))
      .map((node) => this.#viewOf(node));
  }

  /**
   * The first main session started: where an approval asked outside the loop goes. Throws when
   * the conversation has none.
   */
  firstMainId(): SessionId {
    const main = this.list().find(isMainSession);

    if (!main) {
      throw new SessionError({
        reason: 'unknown_session',
        sessionId: sessionIdSchema.parse('main'),
        message: 'An approval outside a session needs a main session to go under',
      });
    }

    return main.id;
  }

  /** `id` and every session under it, the session itself first; none for an unknown id. */
  subtree(id: SessionId): SessionInfo[] {
    const root = this.get(id);

    if (!root) return [];

    const found = [root];

    for (const session of this.list()) {
      if ('parentId' in session && found.some((member) => member.id === session.parentId)) {
        found.push(session);
      }
    }

    return found;
  }

  /** Starts the session `params` names, running, under its parent. */
  add(params: SessionRef & { title: string }): SessionInfo {
    const parent = 'parentId' in params ? this.#require(params.parentId) : undefined;
    const node = this.registry.open({
      kind: 'agent',
      title: params.title,
      ...(parent && {
        parent,
        spawnedBy: 'startedByCall' in params ? params.startedByCall : undefined,
      }),
    });

    this.#link({ session: params.id, node: node.id });

    return this.#viewOf(node);
  }

  /** Puts back a session as a stored conversation left it; its parent must be back already. */
  restore(session: SessionInfo): SessionInfo {
    // Two stored sessions under one id would orphan the first node, which could never be released.
    if (this.#nodeOf.has(session.id)) {
      throw new SessionError({
        reason: 'unknown_session',
        sessionId: session.id,
        message: `Session ${session.id} is stored twice`,
      });
    }

    const parent = 'parentId' in session ? this.#require(session.parentId) : undefined;
    const node = this.registry.restore({
      kind: 'agent',
      title: session.title,
      startedAt: session.startedAt,
      ...('parentId' in session && parent && { parent, spawnedBy: session.startedByCall }),
      ...(session.modelId && { modelId: session.modelId }),
      ...(session.effort && { effort: session.effort }),
      ...restoredFieldsOf(session),
    });

    this.#link({ session: session.id, node: node.id });

    return this.#viewOf(node);
  }

  /** Returns whether the status changed: one with nothing in it does not. */
  report(params: { id: SessionId; status: string }): boolean {
    return this.registry.setStatus({ id: this.#require(params.id), status: params.status });
  }

  /**
   * The first session still open in `id`'s subtree, or `id` itself when what is open is a command, a
   * service or another node that is not a session: either way the subtree cannot be released yet.
   */
  openBelow(id: SessionId): SessionInfo | undefined {
    const open = this.registry
      .subtree(this.#require(id))
      .find((node) => node.state === 'running' || node.state === 'idle');

    return open && this.get(this.#sessionOf.get(open.id) ?? id);
  }

  /** Returns whether the model changed: the same model and effort are not a change. */
  setModel(params: { id: SessionId; modelId: ModelId; effort?: ModelEffort | undefined }): boolean {
    const { id, modelId, effort } = params;

    return this.registry.setModel({ id: this.#require(id), modelId, effort });
  }

  idle(params: { id: SessionId; outcome: RunOutcome }): void {
    this.registry.idle({ id: this.#require(params.id), outcome: params.outcome });
  }

  resume(id: SessionId): void {
    this.registry.resume(this.#require(id));
  }

  end(params: { id: SessionId; state: RunOutcome }): void {
    this.registry.endAgent({ id: this.#require(params.id), outcome: params.state });
  }

  /** Closes a session left open by a server that stopped as lost: the repair of a reopen. */
  lose(id: SessionId): void {
    this.registry.lose(this.#require(id));
  }

  /** Forgets the ended session `id` and what it started; returns them as they last were. */
  release(id: SessionId): SessionInfo[] {
    const subtree = this.subtree(id);

    this.registry.release(this.#require(id));

    for (const session of subtree) {
      const nodeId = this.#nodeOf.get(session.id);

      this.#nodeOf.delete(session.id);
      if (nodeId !== undefined) this.#sessionOf.delete(nodeId);
    }

    return subtree;
  }

  #link(params: { session: SessionId; node: NodeId }): void {
    this.#nodeOf.set(params.session, params.node);
    this.#sessionOf.set(params.node, params.session);
  }

  #require(id: SessionId): NodeId {
    const nodeId = this.#nodeOf.get(id);

    if (nodeId === undefined) {
      throw new SessionError({
        reason: 'unknown_session',
        sessionId: id,
        message: `Unknown session ${id}`,
      });
    }

    return nodeId;
  }

  #sessionIdOf(nodeId: NodeId): SessionId {
    const id = this.#sessionOf.get(nodeId);

    if (id === undefined) {
      throw new SessionError({
        reason: 'unknown_session',
        sessionId: sessionIdSchema.parse(nodeId),
        message: `Node ${nodeId} is not a session`,
      });
    }

    return id;
  }

  #viewOf(node: NodeRecord): SessionInfo {
    const lineage = this.registry.lineage(node.id);
    const root = lineage.at(-1);
    const outcome = sessionOutcomeOf(node);
    const details = {
      id: this.#sessionIdOf(node.id),
      rootId: this.#sessionIdOf(root?.id ?? node.id),
      title: node.title,
      state: sessionStateOf(node),
      startedAt: node.startedAt,
      ...(node.status !== undefined && { status: node.status }),
      ...(outcome && { lastOutcome: outcome }),
      ...(node.endedAt !== undefined && { endedAt: node.endedAt }),
      ...(node.modelId && { modelId: node.modelId }),
      ...(node.effort && { effort: node.effort }),
    };

    // A sub-agent is a node with a parent; the call that started it is any string, an empty one too.
    if (node.parent === undefined) return { ...details, depth: 1 };

    if (node.spawnedBy === undefined) {
      throw new SessionError({
        reason: 'unknown_session',
        sessionId: details.id,
        message: `Session ${details.id} has a parent but no tool call that started it`,
      });
    }

    return {
      ...details,
      depth: lineage.length,
      parentId: this.#sessionIdOf(node.parent),
      startedByCall: node.spawnedBy,
    };
  }
}

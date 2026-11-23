import { randomUUID } from 'node:crypto';
import { now } from '@sheavly/core/clock/clock.helper';
import type { ModelEffort, ModelId } from '@sheavly/protocol/model/model.types';
import {
  MAX_NODE_STATUS_CHARS,
  MAX_NODE_TITLE_CHARS,
  MAX_TREE_NODES,
} from '@sheavly/protocol/node/node.constants';
import type { NodeId } from '@sheavly/protocol/node/node.types';
import { isConsistentNode } from '@sheavly/protocol/node/node.utils';
import { nodeIdSchema } from '@sheavly/protocol/node/node.validator';
import type { RunOutcome } from '@sheavly/protocol/session/session.types';
import { NODE_STATE_OF_OUTCOME } from '@sheavly/protocol/status/status.constants';
import { canTransition } from '@sheavly/protocol/status/status.utils';
import { NodeError } from '../errors/nodes.errors.js';
import { ChannelLog } from './channel-log.service.js';
import { UNTITLED } from './nodes.constants.js';
import type {
  NodeEntry,
  NodeRecord,
  NodeState,
  OpenNode,
  ReadableChannel,
  RestoredNode,
} from './nodes.types.js';
import {
  callIdOnNode,
  depthOf,
  isOpenState,
  isVisibleTo,
  oneLineOf,
  subtreeOf,
} from './nodes.utils.js';

/** How a node of any kind other than an agent ends; an agent ends with how its last run did. */
type WorkEnd = Extract<NodeState, 'completed' | 'failed' | 'cancelled'>;

/**
 * Every node of one conversation, whatever its kind: the main agent, a sub-agent, a command, a
 * service, a kind an extension adds. It owns each node's lifecycle through the protocol's one
 * status machine (`STATUS_TABLE.node`): a move the table does not list is refused, and a node
 * reaches a terminal state once, on every path. It keeps who started each node, so a caller sees
 * only what it owns, and the release rules of finished nodes.
 *
 * It appends each change to the node's own channel and to the conversation's tree channel
 * (`ReadableChannel`), in memory. A node's id is minted here and never reused, so one that was
 * released or left in a stored conversation is never taken by another.
 */
export class NodeRegistry {
  readonly #nodes = new Map<NodeId, NodeRecord>();
  readonly #channels = new Map<NodeId, ChannelLog>();
  readonly #tree = new ChannelLog();
  readonly #released = new Set<NodeId>();

  /** What exists and what changed, for every node: the channel a sidebar reads. */
  get tree(): ReadableChannel {
    return this.#tree;
  }

  /** Starts a node, running, under `parent` (unknown or released: refused). */
  open(params: OpenNode): NodeRecord {
    return this.#add({ ...params, state: 'running', startedAt: now() });
  }

  /**
   * Puts back a node a stored conversation had, as it was: open, idle or ended. Its channel begins
   * with `opened` as it is restored, and, for one that ended, `closed`. Throws when the pieces
   * contradict each other (`isConsistentNode`).
   */
  restore(params: RestoredNode): NodeRecord {
    const node = this.#add(params);

    if (!isOpenState(node.state)) this.#append({ type: 'closed', node });

    return { ...node };
  }

  get(id: NodeId): NodeRecord | undefined {
    const node = this.#nodes.get(id);

    return node && { ...node };
  }

  /** Every node, or with a `caller` only what it started and what nobody did. */
  list(caller?: NodeId): NodeRecord[] {
    return [...this.#nodes.values()]
      .filter((node) => isVisibleTo({ node, caller }))
      .map((node) => ({ ...node }));
  }

  /** The nodes `id` started directly. */
  children(id: NodeId): NodeRecord[] {
    return this.list().filter((node) => node.parent === id);
  }

  /** `id` and every ancestor, up to the root (last). */
  lineage(id: NodeId): NodeRecord[] {
    const found: NodeRecord[] = [];

    for (let next: NodeId | undefined = id; next !== undefined; next = found.at(-1)?.parent) {
      found.push(this.#require(next));
    }

    return found.map((node) => ({ ...node }));
  }

  /** How deep `id` is: the main agent is 1, a sub-agent of it 2. */
  depth(id: NodeId): number {
    return depthOf({ node: this.#require(id), nodes: this.#nodes });
  }

  /** The tree as it stands, and the position to read on from. */
  snapshot(): { nodes: NodeRecord[]; cursor: number } {
    return { nodes: this.list(), cursor: this.#tree.next };
  }

  /** One node's own channel. Throws for an unknown or released node. */
  channel(id: NodeId): ReadableChannel {
    this.#require(id);

    const channel = this.#channels.get(id);

    if (!channel) throw this.#missing(id);

    return channel;
  }

  /**
   * What an agent says it is doing now. Ignored once the node ended, when it has nothing in it, or
   * when it is the status the node already has (a log entry for no change would only grow the
   * channel); returns whether it changed.
   */
  setStatus(params: { id: NodeId; status: string }): boolean {
    const node = this.#require(params.id);
    const status = oneLineOf({ text: params.status, max: MAX_NODE_STATUS_CHARS });

    if (!isOpenState(node.state) || status === undefined || status === node.status) return false;

    node.status = status;
    this.#append({ type: 'updated', node });

    return true;
  }

  /** The model a node runs on. Returns whether it changed: the same model and effort do not. */
  setModel(params: { id: NodeId; modelId: ModelId; effort?: ModelEffort | undefined }): boolean {
    const { id, modelId, effort } = params;
    const node = this.#require(id);

    if (!isOpenState(node.state) || (node.modelId === modelId && node.effort === effort)) {
      return false;
    }

    node.modelId = modelId;
    if (effort) node.effort = effort;
    else delete node.effort;
    this.#append({ type: 'updated', node });

    return true;
  }

  /**
   * A conversation's prompt finished and the agent stays open for the next: `outcome` is how that
   * run ended. Only a running agent goes idle; for any other state this does nothing and returns
   * false. Throws for a node that is not an agent: only an agent has a between-prompts state.
   */
  idle(params: { id: NodeId; outcome: RunOutcome }): boolean {
    const node = this.#requireAgent(params.id);

    if (node.state !== 'running') return false;

    this.#move({ node, to: 'idle' });
    node.lastOutcome = params.outcome;
    this.#append({ type: 'updated', node });

    return true;
  }

  /** The next prompt starts: an idle agent runs again. Throws for any other state. */
  resume(id: NodeId): void {
    const node = this.#requireAgent(id);

    this.#move({ node, to: 'running' });
    this.#append({ type: 'updated', node });
  }

  /**
   * Ends an agent for good, with how its last run finished: its state is the one that outcome
   * gives. Ending again keeps the first ending and returns false.
   */
  endAgent(params: { id: NodeId; outcome: RunOutcome }): boolean {
    const { id, outcome } = params;

    return this.#close({
      node: this.#requireAgent(id),
      state: NODE_STATE_OF_OUTCOME[outcome],
      outcome,
    });
  }

  /** Ends a command, a service or an extension's node. Ending again keeps the first ending. */
  endWork(params: { id: NodeId; state: WorkEnd }): boolean {
    const node = this.#require(params.id);

    if (node.kind === 'agent') {
      throw new NodeError({
        reason: 'invalid_outcome',
        nodeId: node.id,
        message: `Node ${node.id} is an agent: it ends with the outcome of its last run (endAgent)`,
      });
    }

    return this.#close({ node, state: params.state });
  }

  /**
   * Closes a node the server stopped under as `lost`. It is the repair of a reopened conversation,
   * for a node that was open when the process ended: a live node ends through `endAgent` or
   * `endWork`, never through this. Returns false for one that already ended.
   */
  lose(id: NodeId): boolean {
    return this.#close({ node: this.#require(id), state: 'lost' });
  }

  /**
   * Forgets the ended node `id` and every node under it, and returns what went, as it last was.
   * Throws `node_running` before removing anything when one of them is still open. Their ids are
   * never taken again.
   */
  release(id: NodeId): NodeRecord[] {
    const subtree = this.subtree(id);
    const open = subtree.find((node) => isOpenState(node.state));

    if (open) {
      throw new NodeError({
        reason: 'node_running',
        nodeId: open.id,
        message: `Node ${open.id} is ${open.state}; only ended nodes can be released`,
      });
    }

    for (const node of subtree) {
      this.#nodes.delete(node.id);
      this.#channels.delete(node.id);
      this.#released.add(node.id);
    }

    return subtree;
  }

  /** `id` and every node under it, as copies, `id` first. Throws for an unknown or released node. */
  subtree(id: NodeId): NodeRecord[] {
    return subtreeOf({ id: this.#require(id).id, nodes: this.#nodes }).map((node) => ({ ...node }));
  }

  /** Whether `id` was a node of this registry that has since been released. */
  isReleased(id: NodeId): boolean {
    return this.#released.has(id);
  }

  #add(params: RestoredNode & { state: NodeState; startedAt: number }): NodeRecord {
    const { kind, parent, title, state, startedAt } = params;
    const status =
      params.status === undefined
        ? undefined
        : oneLineOf({ text: params.status, max: MAX_NODE_STATUS_CHARS });

    if (parent !== undefined) this.#require(parent);

    // The tree's snapshot holds every node, so a conversation holds at most that many, ended ones
    // included: finished work is released at the turn boundary, which makes room.
    if (this.#nodes.size >= MAX_TREE_NODES) {
      throw new NodeError({
        reason: 'too_many_nodes',
        message: `${String(MAX_TREE_NODES)} nodes are already held; release finished ones first`,
      });
    }

    const node: NodeRecord = {
      id: nodeIdSchema.parse(randomUUID()),
      kind,
      title: oneLineOf({ text: title, max: MAX_NODE_TITLE_CHARS }) ?? UNTITLED,
      state,
      startedAt,
      ...(parent && { parent }),
      ...(status !== undefined && { status }),
      ...(params.endedAt !== undefined && { endedAt: params.endedAt }),
      ...(params.spawnedBy !== undefined && { spawnedBy: callIdOnNode(params.spawnedBy) }),
      ...(params.modelId && { modelId: params.modelId }),
      ...(params.effort && { effort: params.effort }),
      ...(params.lastOutcome && { lastOutcome: params.lastOutcome }),
    };

    if (!isConsistentNode(node)) {
      throw new NodeError({
        reason: 'inconsistent_node',
        message: `A node cannot be ${state} with that end time and outcome`,
      });
    }

    this.#nodes.set(node.id, node);
    this.#channels.set(node.id, new ChannelLog());
    this.#append({ type: 'opened', node });

    return { ...node };
  }

  #close(params: { node: NodeRecord; state: NodeState; outcome?: RunOutcome }): boolean {
    const { node, state, outcome } = params;

    if (!isOpenState(node.state)) return false;

    this.#move({ node, to: state });
    node.endedAt = now();
    if (outcome) node.lastOutcome = outcome;
    this.#append({ type: 'closed', node });

    return true;
  }

  /** Moves `node` to `to` if the status table lists the move, and throws otherwise. */
  #move(params: { node: NodeRecord; to: NodeState }): void {
    const { node, to } = params;

    if (!canTransition({ machine: 'node', from: node.state, to })) {
      throw new NodeError({
        reason: 'invalid_transition',
        nodeId: node.id,
        message: `Node ${node.id} is ${node.state}; it cannot become ${to}`,
      });
    }

    node.state = to;
  }

  #append(params: { type: NodeEntry['type']; node: NodeRecord }): void {
    this.#channels.get(params.node.id)?.append(params);
    this.#tree.append(params);
  }

  #require(id: NodeId): NodeRecord {
    const node = this.#nodes.get(id);

    if (!node) throw this.#missing(id);

    return node;
  }

  #requireAgent(id: NodeId): NodeRecord {
    const node = this.#require(id);

    if (node.kind !== 'agent') {
      throw new NodeError({
        reason: 'not_an_agent',
        nodeId: id,
        message: `Node ${id} is a ${node.kind}: only an agent goes idle and runs again`,
      });
    }

    return node;
  }

  #missing(id: NodeId): NodeError {
    return this.#released.has(id)
      ? new NodeError({ reason: 'node_released', nodeId: id, message: `Node ${id} was released` })
      : new NodeError({ reason: 'unknown_node', nodeId: id, message: `No node ${id}` });
  }
}

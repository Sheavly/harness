import { MAX_TREE_NODES } from '@sheavly/protocol/node/node.constants';
import type { NodeId } from '@sheavly/protocol/node/node.types';
import type { EntryEvent } from '@sheavly/protocol/event/event.types';
import type {
  ModelUsage,
  NodeUsage,
  UsageFigures,
  UsageView,
} from '@sheavly/protocol/usage/usage.types';
import { emptyUsage, emptyUsageFigures } from '@sheavly/protocol/usage/usage.utils';
import { contextFillOf, withCall } from './node-usage.utils.js';
import type { NodeUsageChange } from './usage.types.js';

/**
 * What each node's model calls have used, and the total, counted from the loop's `usage` events: the
 * one place usage is counted, so a client never has to. A turn that ends with no usage reported
 * marks its node, and so the total, `incomplete`.
 *
 * It keeps at most `MAX_TREE_NODES` records. Past that the oldest records of nodes that are not
 * open (`isOpen`) are dropped; their calls were counted in the total, which only ever grows, so the
 * total covers every call whatever the records say. A reopened conversation goes on from `initial`,
 * the view its stored channel left.
 */
export class NodeUsageLedger {
  readonly #records: Map<NodeId, NodeUsage>;
  readonly #isOpen: (node: NodeId) => boolean;
  /** The nodes whose turn has reported usage and not yet ended: a turn with none is incomplete. */
  readonly #reported = new Set<NodeId>();
  #total: UsageFigures;

  constructor(params: { isOpen: (node: NodeId) => boolean; initial?: UsageView }) {
    const initial = params.initial ?? emptyUsage();

    this.#isOpen = params.isOpen;
    this.#records = new Map(initial.nodes.map((record) => [record.node, record]));
    this.#total = initial.total;
  }

  /** The usage as it stands: the total, and each node's record in the order they first made a call. */
  get view(): UsageView {
    return { total: this.#total, nodes: [...this.#records.values()] };
  }

  /**
   * Counts what `event`, an event of `node`'s loop, says of usage: a model call it reported, or a
   * turn that ended. Undefined for every other event and for one that changes nothing.
   */
  observe(params: { node: NodeId; event: EntryEvent }): NodeUsageChange | undefined {
    const { node, event } = params;

    if (event.type === 'usage') return this.#called({ node, usage: event.usage });
    if (event.type === 'turn_end') return this.#turnEnded(node);

    return undefined;
  }

  #called(params: { node: NodeId; usage: ModelUsage }): NodeUsageChange {
    const { node, usage } = params;
    const record = this.#recordOf(node);
    const context = contextFillOf(usage) ?? record.context;

    // A summary call is billed, but it does not stand in for the turn's own report.
    if (usage.purpose !== 'summary') this.#reported.add(node);

    this.#total = withCall({ figures: this.#total, usage });

    return this.#kept({ ...withCall({ figures: record, usage }), ...(context && { context }) });
  }

  #turnEnded(node: NodeId): NodeUsageChange | undefined {
    if (this.#reported.delete(node)) return undefined;

    const record = this.#recordOf(node);

    if (record.incomplete) return undefined;

    this.#total = { ...this.#total, incomplete: true };

    return this.#kept({ ...record, incomplete: true });
  }

  #recordOf(node: NodeId): NodeUsage {
    return this.#records.get(node) ?? { ...emptyUsageFigures(), node };
  }

  /** Keeps `record`, a node's first or its newer one, dropping what it makes more than may be kept. */
  #kept(record: NodeUsage): NodeUsageChange {
    this.#records.set(record.node, record);

    return { usage: record, total: this.#total, evicted: this.#evict(record.node) };
  }

  /** Drops the oldest records of nodes that are not open until `MAX_TREE_NODES` are left; not `keep`. */
  #evict(keep: NodeId): NodeId[] {
    const evicted: NodeId[] = [];

    for (const node of this.#records.keys()) {
      if (this.#records.size <= MAX_TREE_NODES) break;
      if (node === keep || this.#isOpen(node)) continue;

      this.#records.delete(node);
      evicted.push(node);
    }

    return evicted;
  }
}

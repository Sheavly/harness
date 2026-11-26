import type { StoreError } from '@sheavly/core/errors/store.errors';
import type { ChannelLog, ConversationStore } from '@sheavly/core/store/store.types';
import type { ApprovalId, ApprovalUpdate } from '@sheavly/protocol/approval/approval.types';
import type { MessageId } from '@sheavly/protocol/message/message.types';
import { TREE_CHANNEL_NAME } from '@sheavly/protocol/node/node.constants';
import type { NodeId } from '@sheavly/protocol/node/node.types';
import type { ConversationId } from '@sheavly/protocol/server/server.types';
import type { SessionId } from '@sheavly/protocol/session/session.types';
import type { TreeChannelEntry, TreeSnapshot, TreeView } from '@sheavly/protocol/tree/tree.types';
import { applyTreeEntry, emptyTree, treeSnapshotOf } from '@sheavly/protocol/tree/tree.utils';
import { treeChannelEntrySchema } from '@sheavly/protocol/tree/tree.validator';
import type { ApprovalRegistry } from '../approvals/approvals.service.js';
import type { TaskRegistry } from '../tasks/tasks.service.js';
import type { NodeRegistry } from './node-registry.service.js';
import type {
  ConversationChannel,
  NodeChannelStorage,
  NodeEntry,
  ResumedTree,
} from './nodes.types.js';
import { isOpenState } from './nodes.utils.js';
import { readStoredChannel } from './stored-channel.helper.js';
import { StoredChannel } from './stored-channel.service.js';
import {
  agentNodeEntry,
  approvalCancelledEntry,
  approvalRequestedEntry,
  approvalResolvedEntry,
  lostNodeEntry,
  promptRefusedEntry,
  promptStartedEntry,
  queueChangedEntry,
  storageFailedEntry,
  treeOpenedEntry,
  workNodeEntry,
} from './tree-channel-entries.utils.js';

/**
 * Stores a conversation's tree channel: what exists (a node opening, changing, closing), what waits
 * for the user (an approval), and the conversation's own notices (its queue, a storage failure).
 * It is told what the node registry, the task registry and the approval registry do, numbers each
 * entry as it is told (0, 1, 2, … with no gap, the channel's own cursor), and writes them one after
 * another, in the order they happened.
 *
 * It keeps the tree the entries the store has taken build (`applyTreeEntry`) beside the cursor of
 * the last one, so `snapshot` is the tree of exactly those entries: a client that starts from it and
 * follows from its cursor gets what one that replayed the channel from the start gets. The storing
 * itself, with its ordering and its failure, is the stored channel's (`StoredChannel`).
 */
export class TreeChannelWriter
  extends StoredChannel<TreeChannelEntry, TreeView, TreeSnapshot>
  implements ConversationChannel
{
  /** Who asked each approval that is waiting, to say so when it is answered or given up. */
  readonly #askedBy = new Map<ApprovalId, NodeId>();

  constructor(storage: {
    log: ChannelLog;
    onFailure?: ((failure: StoreError) => void) | undefined;
    resumed?: ResumedTree | undefined;
  }) {
    const { resumed } = storage;

    super({
      name: TREE_CHANNEL_NAME,
      log: storage.log,
      schema: treeChannelEntrySchema,
      empty: emptyTree(),
      apply: ({ view, entry }) => applyTreeEntry({ tree: view, entry }),
      snapshotOf: ({ view, cursor, at }) => treeSnapshotOf({ tree: view, cursor, at }),
      onFailure: storage.onFailure,
      resumed:
        resumed && 'failure' in resumed
          ? resumed
          : resumed && { next: resumed.next, last: resumed.last, view: resumed.tree },
    });
  }

  /**
   * The stored tree channel of a conversation being reopened, for `NodeChannelStorage.resumedTree`:
   * where it stands and the tree its entries build. Undefined when none is stored (a conversation
   * kept before it was). A channel it cannot go on from, because an entry is damaged, it ends in
   * `closed` (a closed channel takes no more) or the store fails, is a failure instead, so the
   * conversation still reopens and the writer reports why it writes nothing.
   */
  static async readStored(params: {
    store: Pick<ConversationStore, 'channel' | 'channels'>;
    id: ConversationId;
  }): Promise<ResumedTree | undefined> {
    const resumed = await readStoredChannel({
      ...params,
      name: TREE_CHANNEL_NAME,
      schema: treeChannelEntrySchema,
      empty: emptyTree(),
      apply: ({ view, entry }) => applyTreeEntry({ tree: view, entry }),
    });

    if (!resumed || 'failure' in resumed) return resumed;

    return { next: resumed.next, last: resumed.last, tree: resumed.view };
  }

  /**
   * Starts storing a conversation's tree channel, from what its registries do from now on. Call it
   * once, right after the registries are made: the channel opens, and each node they already hold
   * that is still open (the main agent) opens on it. `askedBy` says which node an approval's
   * session is: an approval that asks for none is the main agent's, and one whose session has no
   * node is not on the tree (it is still on the conversation's stream).
   */
  static attach(params: {
    nodes: NodeRegistry;
    tasks: TaskRegistry;
    approvals: Pick<ApprovalRegistry, 'observe'>;
    nodeIdOf: (session: SessionId) => NodeId | undefined;
    storage: NodeChannelStorage;
  }): TreeChannelWriter {
    const { nodes, tasks, approvals, nodeIdOf, storage } = params;
    const writer = new TreeChannelWriter({
      log: storage.log(TREE_CHANNEL_NAME),
      onFailure: storage.onFailure,
      resumed: storage.resumedTree,
    });
    const rootId = () => nodes.list().find((node) => node.parent === undefined)?.id;

    if (storage.resumedTree) writer.#closeStale();
    else writer.tell((stamp) => treeOpenedEntry(stamp));

    // Parents before children: the registry lists nodes in the order they were made.
    for (const node of nodes.list()) {
      if (node.kind === 'agent' && isOpenState(node.state)) {
        writer.tell((stamp) => agentNodeEntry({ ...stamp, type: 'node_opened', node }));
      }
    }

    nodes.tree.follow((entry) => {
      writer.#agent(entry);
    }, 'now');
    tasks.observe(({ update, nodeId }) => {
      const node = tasks.nodes.get(nodeId);

      if (!node || (node.kind !== 'command' && node.kind !== 'service')) return;

      const type = update.type === 'task_started' ? 'node_opened' : 'node_closed';

      writer.tell((stamp) => workNodeEntry({ ...stamp, type, node, task: update.task }));
    });
    approvals.observe((update) => {
      writer.#approval({
        update,
        asker: (session) => (session === undefined ? rootId() : nodeIdOf(session)),
      });
    });

    return writer;
  }

  /** The conversation's queue changed: a line joined it, or a client replaced the lines. */
  noteQueueChanged(queued: readonly string[]): void {
    this.tell((stamp) => queueChangedEntry({ ...stamp, queued }));
  }

  /** A queued line started as the conversation's next prompt. */
  notePromptStarted(params: {
    text: string;
    messageId: MessageId;
    queued: readonly string[];
  }): void {
    this.tell((stamp) => promptStartedEntry({ ...stamp, ...params }));
  }

  /** A queued line left the queue without starting. */
  notePromptRefused(params: { text: string; error: string; queued: readonly string[] }): void {
    this.tell((stamp) => promptRefusedEntry({ ...stamp, ...params }));
  }

  /** The conversation could not be stored. */
  noteStorageFailed(error: string): void {
    this.tell((stamp) => storageFailedEntry({ ...stamp, error }));
  }

  /**
   * A reopened conversation finds, in the tree it goes on from, what the stopped process left: nodes
   * still open, which nobody saw end, are closed as `lost`, and approvals still waiting, which
   * nobody can answer now, are given up. The channel then goes on with this process's own nodes.
   */
  #closeStale(): void {
    const { nodes, approvals } = this.view;

    for (const node of nodes) {
      if (isOpenState(node.state)) this.tell((stamp) => lostNodeEntry({ ...stamp, node }));
    }

    for (const { node, request } of approvals) {
      this.tell((stamp) => approvalCancelledEntry({ ...stamp, node, id: request.id }));
    }
  }

  /** An agent opened, changed or closed. A node of another kind is not on this channel here. */
  #agent(entry: NodeEntry): void {
    const { node } = entry;

    if (node.kind !== 'agent') return;

    const type = { opened: 'node_opened', updated: 'node_updated', closed: 'node_closed' }[
      entry.type
    ] as 'node_opened' | 'node_updated' | 'node_closed';

    this.tell((stamp) => agentNodeEntry({ ...stamp, type, node }));
  }

  /** What the approval registry says: asked for, answered, or given up. */
  #approval(params: {
    update: ApprovalUpdate;
    asker: (session: SessionId | undefined) => NodeId | undefined;
  }): void {
    const { update, asker } = params;

    if (update.type === 'approval_requested') {
      const node = asker(update.request.sessionId);

      if (node === undefined) return;

      this.#askedBy.set(update.request.id, node);
      this.tell((stamp) => approvalRequestedEntry({ ...stamp, node, request: update.request }));

      return;
    }

    const node = this.#askedBy.get(update.id);

    if (node === undefined) return;

    this.#askedBy.delete(update.id);

    if (update.type === 'approval_resolved') {
      this.tell((stamp) =>
        approvalResolvedEntry({ ...stamp, node, id: update.id, response: update.response }),
      );
    } else {
      this.tell((stamp) => approvalCancelledEntry({ ...stamp, node, id: update.id }));
    }
  }
}

import { now } from '@sheavly/core/clock/clock.helper';
import { StoreError } from '@sheavly/core/errors/store.errors';
import type { ChannelEntry, ChannelLog, ConversationStore } from '@sheavly/core/store/store.types';
import { toStoreError } from '@sheavly/core/store/store.utils';
import type { ApprovalId, ApprovalUpdate } from '@sheavly/protocol/approval/approval.types';
import type { MessageId } from '@sheavly/protocol/message/message.types';
import { TREE_CHANNEL_NAME } from '@sheavly/protocol/node/node.constants';
import type { NodeId } from '@sheavly/protocol/node/node.types';
import type { ConversationId } from '@sheavly/protocol/server/server.types';
import type { SessionId } from '@sheavly/protocol/session/session.types';
import type { TreeSnapshot, TreeView } from '@sheavly/protocol/tree/tree.types';
import { applyTreeEntry, emptyTree, treeSnapshotOf } from '@sheavly/protocol/tree/tree.utils';
import { treeChannelEntrySchema } from '@sheavly/protocol/tree/tree.validator';
import type { ApprovalRegistry } from '../approvals/approvals.service.js';
import { notifyAll } from '../sessions/listeners.helper.js';
import type { TaskRegistry } from '../tasks/tasks.service.js';
import { ChannelFollowers } from './channel-followers.service.js';
import type { NodeRegistry } from './node-registry.service.js';
import type {
  ChannelEvent,
  NodeChannelStorage,
  NodeEntry,
  ResumedTree,
  TreeStamp,
} from './nodes.types.js';
import { isOpenState } from './nodes.utils.js';
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
 * follows from its cursor gets what one that replayed the channel from the start gets.
 *
 * A write that fails leaves the channel as it was: it takes no more entries, so a log never reads
 * as whole with an entry missing. The first failure is told to `onFailure`; the run goes on.
 */
export class TreeChannelWriter {
  readonly #log: ChannelLog;
  readonly #onFailure: ((failure: StoreError) => void) | undefined;
  readonly #followers = new ChannelFollowers();
  /** Who asked each approval that is waiting, to say so when it is answered or given up. */
  readonly #askedBy = new Map<ApprovalId, NodeId>();
  /** The position the next entry told gets. */
  #next = 0;
  /** Every write, one after another. Never rejects: a failure is told, not thrown. */
  #written: Promise<void> = Promise.resolve();
  #failure: StoreError | undefined;
  /** The tree the stored entries build, and the last of them. */
  #tree: TreeView = emptyTree();
  #last: { cursor: string; at: number } | undefined;
  /** The writer was stopped: no entry is told after it. */
  #stopped = false;
  /** Whether it stopped or failed and what was told is written: nothing more will be. */
  #ended = false;

  constructor(storage: {
    log: ChannelLog;
    onFailure?: ((failure: StoreError) => void) | undefined;
    resumed?: ResumedTree | undefined;
  }) {
    this.#log = storage.log;
    this.#onFailure = storage.onFailure;

    const { resumed } = storage;

    if (resumed && 'failure' in resumed) {
      // Gone on from nothing it can read: the channel is left as it is, and the failure is told.
      this.#ended = true;
      this.#fail(resumed.failure);
    } else if (resumed) {
      this.#next = resumed.next;
      this.#tree = resumed.tree;
      this.#last = resumed.last;
    }
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
    const { store, id } = params;

    try {
      if (!(await store.channels(id)).includes(TREE_CHANNEL_NAME)) return undefined;

      let tree = emptyTree();
      let last: { cursor: string; at: number } | undefined;

      for await (const stored of store.channel({ id, channel: TREE_CHANNEL_NAME }).read()) {
        const parsed = treeChannelEntrySchema.safeParse(stored);

        if (!parsed.success || parsed.data.type === 'closed') {
          return {
            failure: new StoreError({
              reason: 'invalid',
              message:
                'The stored tree channel cannot be gone on from: an entry is damaged or it is closed',
            }),
          };
        }

        tree = applyTreeEntry({ tree, entry: parsed.data });
        last = { cursor: parsed.data.cursor, at: parsed.data.at };
      }

      return last ? { next: Number(last.cursor.slice(1)) + 1, last, tree } : undefined;
    } catch (caughtError) {
      if (!(caughtError instanceof StoreError)) throw caughtError;

      return { failure: caughtError };
    }
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
    else writer.#tell((stamp) => treeOpenedEntry(stamp));

    // Parents before children: the registry lists nodes in the order they were made.
    for (const node of nodes.list()) {
      if (node.kind === 'agent' && isOpenState(node.state)) {
        writer.#tell((stamp) => agentNodeEntry({ ...stamp, type: 'node_opened', node }));
      }
    }

    nodes.tree.follow((entry) => {
      writer.#agent(entry);
    }, 'now');
    tasks.observe(({ update, nodeId }) => {
      const node = tasks.nodes.get(nodeId);

      if (!node || (node.kind !== 'command' && node.kind !== 'service')) return;

      const type = update.type === 'task_started' ? 'node_opened' : 'node_closed';

      writer.#tell((stamp) => workNodeEntry({ ...stamp, type, node, task: update.task }));
    });
    approvals.observe((update) => {
      writer.#approval({
        update,
        asker: (session) => (session === undefined ? rootId() : nodeIdOf(session)),
      });
    });

    return writer;
  }

  /** The first failed write, if any. The channel takes no more entries after it. */
  get failure(): StoreError | undefined {
    return this.#failure;
  }

  /** Resolves once every entry told so far has been written, or its write has failed. */
  flush(): Promise<void> {
    return this.#written;
  }

  /**
   * The tree as the stored entries leave it, with the cursor of the last: what a client starts
   * from, then follows after that cursor. Waits for the entries told so far to be stored first.
   * Rejects with the failure once the channel has failed, whatever it stored before: it takes no
   * more entries, so the tree would stand still while the conversation went on, and a client that
   * took it for the tree as it is would be wrong without any sign. A writer that was only stopped
   * (the conversation closed) still gives the tree it left.
   */
  async snapshot(): Promise<TreeSnapshot> {
    await this.#written;

    if (this.#failure) throw this.#failure;

    if (!this.#last) {
      throw new StoreError({ reason: 'failed', message: 'The tree channel holds nothing yet' });
    }

    return treeSnapshotOf({ tree: this.#tree, cursor: this.#last.cursor, at: this.#last.at });
  }

  /**
   * Calls `listener` for each entry of the tree channel the store takes from now on, with its place
   * in the log (the entry's number), and once if the channel fails. Returns the stop. What was
   * stored before is the store's: read it after following, and skip the entries it already held.
   */
  follow(listener: (event: ChannelEvent) => void): () => void {
    return this.#followers.follow({ channel: TREE_CHANNEL_NAME, listener });
  }

  /**
   * Whether this writer may still write the channel: it has not failed or been stopped, or what
   * was told before it stopped is not all written yet. After it, a reader that reaches the end of
   * the stored channel has a channel nothing writes.
   */
  writing(): boolean {
    return !this.#ended;
  }

  /** The conversation's queue changed: a line joined it, or a client replaced the lines. */
  noteQueueChanged(queued: readonly string[]): void {
    this.#tell((stamp) => queueChangedEntry({ ...stamp, queued }));
  }

  /** A queued line started as the conversation's next prompt. */
  notePromptStarted(params: {
    text: string;
    messageId: MessageId;
    queued: readonly string[];
  }): void {
    this.#tell((stamp) => promptStartedEntry({ ...stamp, ...params }));
  }

  /** A queued line left the queue without starting. */
  notePromptRefused(params: { text: string; error: string; queued: readonly string[] }): void {
    this.#tell((stamp) => promptRefusedEntry({ ...stamp, ...params }));
  }

  /** The conversation could not be stored. */
  noteStorageFailed(error: string): void {
    this.#tell((stamp) => storageFailedEntry({ ...stamp, error }));
  }

  /**
   * Stops writing, for a conversation that was closed. The channel is not closed: a closed channel
   * takes no more entries, and the conversation, kept in the store, can be reopened and go on from
   * the last one. What was told is written first, then the followers are told nothing more will come
   * (as for a channel that failed: no writer has it). Safe to repeat; resolves once it is done.
   */
  stop(): Promise<void> {
    if (this.#stopped) return this.#written;

    this.#stopped = true;
    this.#written = this.#written.then(() => {
      if (this.#ended) return;

      this.#ended = true;
      this.#followers.tell({ channel: TREE_CHANNEL_NAME, event: { type: 'failed' } });
    });

    return this.#written;
  }

  /**
   * A reopened conversation finds, in the tree it goes on from, what the stopped process left: nodes
   * still open, which nobody saw end, are closed as `lost`, and approvals still waiting, which
   * nobody can answer now, are given up. The channel then goes on with this process's own nodes.
   */
  #closeStale(): void {
    const { nodes, approvals } = this.#tree;

    for (const node of nodes) {
      if (isOpenState(node.state)) this.#tell((stamp) => lostNodeEntry({ ...stamp, node }));
    }

    for (const { node, request } of approvals) {
      this.#tell((stamp) => approvalCancelledEntry({ ...stamp, node, id: request.id }));
    }
  }

  /** An agent opened, changed or closed. A node of another kind is not on this channel here. */
  #agent(entry: NodeEntry): void {
    const { node } = entry;

    if (node.kind !== 'agent') return;

    const type = { opened: 'node_opened', updated: 'node_updated', closed: 'node_closed' }[
      entry.type
    ] as 'node_opened' | 'node_updated' | 'node_closed';

    this.#tell((stamp) => agentNodeEntry({ ...stamp, type, node }));
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
      this.#tell((stamp) => approvalRequestedEntry({ ...stamp, node, request: update.request }));

      return;
    }

    const node = this.#askedBy.get(update.id);

    if (node === undefined) return;

    this.#askedBy.delete(update.id);

    if (update.type === 'approval_resolved') {
      this.#tell((stamp) =>
        approvalResolvedEntry({ ...stamp, node, id: update.id, response: update.response }),
      );
    } else {
      this.#tell((stamp) => approvalCancelledEntry({ ...stamp, node, id: update.id }));
    }
  }

  /**
   * Numbers the entry `build` makes, here and now, and queues its write. A channel that failed or
   * was closed takes no more, and its position is not used.
   */
  #tell(build: (stamp: TreeStamp) => ChannelEntry): void {
    if (this.#ended || this.#stopped) return;

    const entry = build({ position: this.#next, at: now() });

    this.#next += 1;
    this.#written = this.#written.then(() => this.#store(entry));
  }

  /** Writes `entry`, then keeps the tree it makes and tells the followers; a failure ends the channel. */
  async #store(entry: ChannelEntry): Promise<void> {
    if (this.#ended) return;

    try {
      // An entry no client could read is never stored: the channel is the contract's, not ours.
      const parsed = treeChannelEntrySchema.parse(entry);

      await this.#log.append(entry);
      this.#tree = applyTreeEntry({ tree: this.#tree, entry: parsed });
      this.#last = { cursor: entry.cursor, at: entry.at };
      this.#followers.tell({
        channel: TREE_CHANNEL_NAME,
        event: { type: 'stored', entry, ordinal: Number(entry.cursor.slice(1)) },
      });
    } catch (caughtError) {
      this.#ended = true;
      this.#followers.tell({ channel: TREE_CHANNEL_NAME, event: { type: 'failed' } });
      this.#fail(caughtError);
    }
  }

  #fail(caughtError: unknown): void {
    if (this.#failure) return;

    this.#failure = toStoreError({
      error: caughtError,
      message: 'Could not store the conversation’s tree channel',
    });

    if (this.#onFailure) {
      // Like a listener: a throw must not reject `#written`, which every later write chains on.
      notifyAll({ listeners: [this.#onFailure], value: this.#failure });
    }
  }
}

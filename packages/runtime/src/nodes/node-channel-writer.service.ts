import { now } from '@sheavly/core/clock/clock.helper';
import { StoreError } from '@sheavly/core/errors/store.errors';
import type { ChannelEntry, ConversationStore } from '@sheavly/core/store/store.types';
import { toStoreError } from '@sheavly/core/store/store.utils';
import type { ConversationId } from '@sheavly/protocol/server/server.types';
import type { TaskInfo } from '@sheavly/protocol/task/task.types';
import { notifyAll } from '../sessions/listeners.helper.js';
import type { TaskRegistry } from '../tasks/tasks.service.js';
import { closeLostChannels } from './lost-channels.helper.js';
import {
  byteCursor,
  closedEntry,
  openedAgentEntry,
  openedWorkEntry,
  sequenceCursor,
  updatedEntry,
} from './node-channel-entries.utils.js';
import type { NodeRegistry } from './node-registry.service.js';
import type {
  ChannelPosition,
  LostChannels,
  NodeChannelStorage,
  NodeEntry,
  NodeRecord,
} from './nodes.types.js';
import { isOpenState } from './nodes.utils.js';

/** What the writer knows of a channel it has begun: where it stands, and whether it still writes. */
type Begun = ({ kind: 'sequence'; next: number } | { kind: 'bytes'; offset: number }) & {
  broken: boolean;
  /** The cursor of the newest entry the store took: what a child's `spawnedAt` can name. */
  stored?: string;
};

/**
 * Stores each node's channel as its own log: `opened`, then, for an agent, an `updated` for each
 * change while it lives, then `closed`. It is told what the registry does (`startAgent`,
 * `followAgent`) and what a task does (`openWork`, `closeWork`), numbers each entry as it is told,
 * and writes them one after another, in the order they happened.
 *
 * Only a channel it saw open is written: a node restored from a stored conversation that ended
 * already has its channel in the store, from the process that lived it, and is not written again;
 * the one a reopened conversation goes on with (the main agent, idle) begins a channel of its own,
 * since a restored node has a new id. A node of a kind an extension adds is not stored: the
 * registry holds none of the data such a node's channel opens with.
 *
 * A write that fails leaves its channel as it was: it takes no more entries, so a log is never read
 * as whole with an entry missing, and a channel with no `closed` entry is closed as `lost` when the
 * conversation is reopened (`closeLost`). The first failure is told to `onFailure`; the run goes on.
 */
export class NodeChannelWriter {
  readonly #storage: NodeChannelStorage;
  readonly #begun = new Map<string, Begun>();
  /** Every write, one after another. Never rejects: a failure is told, not thrown. */
  #written: Promise<void> = Promise.resolve();
  #failure: StoreError | undefined;

  constructor(storage: NodeChannelStorage) {
    this.#storage = storage;
  }

  /**
   * Starts storing a conversation's node channels, from what its registries do from now on. Call
   * it once, right after the registries are made: the nodes they already hold (the main agent, and
   * the ones a reopened conversation restored) are looked at now, and only the ones still open
   * begin a channel. An agent's changes come from the node registry, a command's or a service's
   * from the task registry, which holds what the node registry does not: the command, its exit code
   * and the size of its output. Its nodes are in `tasks.nodes`, the same registry when the tasks
   * are built on the sessions' nodes, which is what `createHarness` does.
   */
  static attach(params: {
    nodes: NodeRegistry;
    tasks: TaskRegistry;
    storage: NodeChannelStorage;
  }): NodeChannelWriter {
    const { nodes, tasks, storage } = params;
    const writer = new NodeChannelWriter(storage);

    // Parents before children: the registry lists nodes in the order they were made.
    for (const node of nodes.list()) writer.startAgent(node);

    nodes.tree.follow((entry) => {
      writer.followAgent(entry);
    }, 'now');
    tasks.observe(({ update, nodeId }) => {
      const node = tasks.nodes.get(nodeId);

      if (!node) return;

      if (update.type === 'task_started') writer.openWork({ node, task: update.task });
      else writer.closeWork({ node, task: update.task });
    });

    return writer;
  }

  /**
   * Closes, as `lost`, the node channels a stopped server left in the store with no `closed` entry
   * (`closeLostChannels`). Call it when a conversation is reopened, before its own nodes exist.
   */
  static async closeLost(params: {
    store: Pick<ConversationStore, 'channel' | 'channels'>;
    id: ConversationId;
    at: number;
  }): Promise<LostChannels> {
    return closeLostChannels(params);
  }

  /** The first failed write, if any. The channel it was for takes no more entries. */
  get failure(): StoreError | undefined {
    return this.#failure;
  }

  /** Resolves once every entry told so far has been written, or its write has failed. */
  flush(): Promise<void> {
    return this.#written;
  }

  /** An entry of the registry's tree. Only an agent's is stored on a channel of its own here. */
  followAgent(entry: NodeEntry): void {
    const { node } = entry;

    if (node.kind !== 'agent') return;

    if (entry.type === 'opened') this.startAgent(node);
    else if (entry.type === 'updated') this.#updateAgent(node);
    else this.#closeAgent(node);
  }

  /**
   * Begins the channel of agent `node`, as it is now: a node that is open and has none yet. A
   * node that already ended is not begun, and neither is one of another kind.
   */
  startAgent(node: NodeRecord): void {
    if (node.kind !== 'agent' || !isOpenState(node.state) || this.#begun.has(node.id)) return;

    const parent = this.#parentOf(node);

    if (!parent) return;

    const state: Begun = { kind: 'sequence', next: 1, broken: false };

    this.#begun.set(node.id, state);
    this.#write({ state, parent, entry: openedAgentEntry({ node, at: now() }) });
  }

  /** A command or a service started: its channel begins, with the command from its `task`. */
  openWork(params: { node: NodeRecord; task: TaskInfo }): void {
    const { node, task } = params;

    if ((node.kind !== 'command' && node.kind !== 'service') || this.#begun.has(node.id)) return;

    const parent = this.#parentOf(node);

    if (!parent) return;

    const state: Begun = { kind: 'bytes', offset: 0, broken: false };

    this.#begun.set(node.id, state);
    this.#write({ state, parent, entry: openedWorkEntry({ node, task, at: now() }) });
  }

  /**
   * A command or a service ended: its channel closes with its state, exit code and error, at the
   * size its output reached (the output store holds the bytes; a channel's offset never goes back).
   */
  closeWork(params: { node: NodeRecord; task: TaskInfo }): void {
    const { node, task } = params;
    const state = this.#begun.get(node.id);

    if (state?.kind !== 'bytes') return;

    const cursor = byteCursor(Math.max(state.offset, task.outputLog?.bytes ?? 0));

    this.#begun.delete(node.id);
    this.#write({ state, entry: closedEntry({ node, at: now(), cursor, task }) });
  }

  #updateAgent(node: NodeRecord): void {
    const state = this.#begun.get(node.id);

    if (state?.kind !== 'sequence' || !isOpenState(node.state)) return;

    this.#write({ state, entry: updatedEntry({ node, at: now(), position: state.next }) });
    state.next += 1;
  }

  #closeAgent(node: NodeRecord): void {
    const state = this.#begun.get(node.id);

    if (state?.kind !== 'sequence') return;

    this.#begun.delete(node.id);
    this.#write({
      state,
      entry: closedEntry({ node, at: now(), cursor: sequenceCursor(state.next) }),
    });
  }

  /**
   * The parent of `node`, for a node another started: its channel's state, which the child's
   * `opened` entry links to once it is written. `{}` for a node with no parent. A parent with no
   * channel cannot be linked to, which the child's `opened` entry needs, so the child is not stored
   * and the failure is told: it is a registry that did not tell the writer of the parent.
   */
  #parentOf(node: NodeRecord): { channel?: string; state?: Begun } | undefined {
    if (node.parent === undefined) return {};

    const state = this.#begun.get(node.parent);

    if (!state) {
      this.#fail(
        new StoreError({
          reason: 'invalid',
          message: `Node ${node.id} was started by a node with no stored channel, so it has none`,
        }),
      );

      return undefined;
    }

    return { channel: node.parent, state };
  }

  /**
   * Queues `entry` for its channel; a channel that failed before takes no more. A child's `opened`
   * (`parent`) says where its parent's channel stood when it was spawned, resolved here, when the
   * write runs, and not when it was told: the writes are one chain, so every entry of the parent
   * told before it has been written or has failed, and the link names the newest the store holds,
   * never a position past it. A parent whose channel holds nothing cannot be linked to, and the
   * child is not stored.
   */
  #write(params: {
    state: Begun;
    entry: ChannelEntry;
    parent?: { channel?: string; state?: Begun };
  }): void {
    const { state, entry, parent } = params;

    this.#written = this.#written.then(async () => {
      if (state.broken) return;

      try {
        const spawnedAt = this.#spawnedAt(parent);

        await this.#storage.log(entry.channel).append({ ...entry, ...spawnedAt });
        state.stored = entry.cursor;
      } catch (caughtError) {
        state.broken = true;
        this.#fail(caughtError);
      }
    });
  }

  /** The `spawnedAt` of a child of `parent`: none for a node with no parent; throws if unlinkable. */
  #spawnedAt(parent: { channel?: string; state?: Begun } | undefined): {
    spawnedAt?: ChannelPosition;
  } {
    if (!parent?.channel) return {};

    const cursor = parent.state?.stored;

    if (cursor === undefined) {
      throw new StoreError({
        reason: 'invalid',
        message: `The channel of node ${parent.channel} holds nothing to link a child to`,
      });
    }

    return { spawnedAt: { channel: parent.channel, cursor } };
  }

  #fail(caughtError: unknown): void {
    if (this.#failure) return;

    this.#failure = toStoreError({
      error: caughtError,
      message: 'Could not store a node’s channel',
    });

    if (this.#storage.onFailure) {
      // Like a listener: a throw must not reject `#written`, which every later write chains on.
      notifyAll({ listeners: [this.#storage.onFailure], value: this.#failure });
    }
  }
}

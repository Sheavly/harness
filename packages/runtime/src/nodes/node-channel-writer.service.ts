import { now } from '@sheavly/core/clock/clock.helper';
import { StoreError } from '@sheavly/core/errors/store.errors';
import type { ChannelEntry, ConversationStore } from '@sheavly/core/store/store.types';
import { toStoreError } from '@sheavly/core/store/store.utils';
import type { EntryEvent } from '@sheavly/protocol/event/event.types';
import type { MessageId } from '@sheavly/protocol/message/message.types';
import type { ConversationId } from '@sheavly/protocol/server/server.types';
import type { StreamEntry } from '@sheavly/protocol/stream/stream.types';
import type { TaskInfo } from '@sheavly/protocol/task/task.types';
import { notifyAll } from '../sessions/listeners.helper.js';
import type { TaskRegistry } from '../tasks/tasks.service.js';
import { ChannelFollowers } from './channel-followers.service.js';
import { closeLostChannels } from './lost-channels.helper.js';
import {
  byteCursor,
  closedEntry,
  eventEntry,
  isTreeOnlyEvent,
  openedAgentEntry,
  openedWorkEntry,
  sequenceCursor,
  updatedEntry,
} from './node-channel-entries.utils.js';
import type { NodeRegistry } from './node-registry.service.js';
import type {
  ChannelEvent,
  ChannelPosition,
  EventSource,
  LostChannels,
  NodeChannelStorage,
  NodeEntry,
  NodeRecord,
  PendingText,
} from './nodes.types.js';
import { isOpenState } from './nodes.utils.js';
import { TextDeltaWindow } from './text-delta-window.service.js';

/** What the writer knows of a channel it has begun: where it stands, and whether it still writes. */
type Begun = ({ kind: 'sequence'; next: number } | { kind: 'bytes'; offset: number }) & {
  broken: boolean;
  /** How many entries the store took: the place the next one has in the channel's log. */
  written: number;
  /** The cursor of the newest entry the store took: what a child's `spawnedAt` can name. */
  stored?: string;
};

/**
 * Stores each node's channel as its own log: `opened`, then, for an agent, an `updated` for each
 * change while it lives and an `event` for each loop event its session sends (`hearEvent`), then
 * `closed`. It is told what the registry does (`startAgent`, `followAgent`), what a task does
 * (`openWork`, `closeWork`) and what the loop publishes, numbers each entry as it is told, and
 * writes them one after another, in the order they happened.
 *
 * Streamed text is the exception to one entry for each event: the `text_delta` events of one
 * session that come within a short window are stored as one (`TextDeltaWindow`), and any entry that
 * comes after them on the channel, an event, an update or the close, stores them first, so the
 * order is the order they happened in.
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
  /** Channels whose node ended and whose `closed` entry is not stored yet: still being written. */
  readonly #closing = new Map<string, Begun>();
  /**
   * Agents that ended and whose `closed` entry waits for the `done` of the run that ended them: the
   * loop ends a run's session just before it sends the run's last event, in the same step, so the
   * close is held until that event is stored, and for no longer than the step.
   */
  readonly #ending = new Map<string, { state: Begun & { kind: 'sequence' }; node: NodeRecord }>();
  readonly #followers = new ChannelFollowers();
  /** Streamed text waiting out its window, to be stored as one entry. */
  readonly #text = new TextDeltaWindow(({ channel, text }) => {
    this.#storeText({ channel, text });
  });
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
   * are built on the sessions' nodes, which is what `createHarness` does. With `events` (the
   * sessions), the loop's events from now on are stored on their agent's channel too.
   */
  static attach(params: {
    nodes: NodeRegistry;
    tasks: TaskRegistry;
    storage: NodeChannelStorage;
    events?: EventSource;
  }): NodeChannelWriter {
    const { nodes, tasks, storage, events } = params;
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
    events?.subscribeEntries((entry) => {
      const channel = events.nodeIdOf(entry.sessionId);

      if (channel !== undefined) writer.hearEvent({ channel, entry });
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

  /**
   * Resolves once every entry told so far has been written, or its write has failed, streamed text
   * still waiting out its window included.
   */
  flush(): Promise<void> {
    for (const channel of [...this.#ending.keys()]) this.#writeClose(channel);

    this.#text.flushAll();

    return this.#written;
  }

  /**
   * Calls `listener` for each entry of `channel` the store takes from now on, with its place in the
   * channel's log, and once if the channel fails. Nothing of what was stored before is told: that
   * is the store's, and `ordinal` lets a reader of it join the two with no gap and no repeat (read
   * the store after following, and skip the entries it already held). Only a channel this writer
   * writes is told of; one a stopped server left is read from the store. Returns the stop.
   */
  follow(params: { channel: string; listener: (event: ChannelEvent) => void }): () => void {
    return this.#followers.follow(params);
  }

  /**
   * Whether this writer may still write `channel`: it began it, no write of it has failed, and its
   * node has not ended or its `closed` entry is still waiting to be stored. A channel with no
   * `closed` entry that it does not write is left as it is: nothing more will come on it.
   */
  writing(channel: string): boolean {
    const state = this.#begun.get(channel) ?? this.#closing.get(channel);

    return state !== undefined && !state.broken;
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
   * An entry of the combined stream, for the agent whose channel is `channel` (the node of the
   * session it is about). A loop event is stored on that channel as an `event` entry, in the order
   * it came; streamed text waits out its window and is stored as one. What is not a loop event, and
   * the two that are the conversation's (`isTreeOnlyEvent`), are not stored here, and neither is an
   * event of a node with no channel this writer writes, or whose channel is closed. An agent that
   * just ended still takes the run's `done`, which the loop sends right after ending the session,
   * and that event is what its `closed` entry comes after.
   */
  hearEvent(params: { channel: string; entry: StreamEntry }): void {
    const { channel, entry } = params;
    const state = this.#sequenceState(channel);

    if (entry.kind !== 'event' || isTreeOnlyEvent(entry.event.type)) return;

    if (!state) return;

    const { event, at, messageId } = entry;

    if (event.type === 'text_delta') {
      this.#text.add({ channel, seq: event.seq, text: event.text, at, messageId });

      return;
    }

    this.#text.flush(channel);
    this.#writeEvent({ channel, state, event, at, messageId });

    if (event.type === 'done') this.#writeClose(channel);
  }

  /** The state of an agent's channel that still takes entries: one that is open, or has just ended. */
  #sequenceState(channel: string): (Begun & { kind: 'sequence' }) | undefined {
    const state = this.#begun.get(channel) ?? this.#ending.get(channel)?.state;

    return state?.kind === 'sequence' ? state : undefined;
  }

  /**
   * Begins the channel of agent `node`, as it is now: a node that is open and has none yet. A
   * node that already ended is not begun, and neither is one of another kind.
   */
  startAgent(node: NodeRecord): void {
    if (node.kind !== 'agent' || !isOpenState(node.state) || this.#begun.has(node.id)) return;

    const parent = this.#parentOf(node);

    if (!parent) return;

    const state: Begun = { kind: 'sequence', next: 1, broken: false, written: 0 };

    this.#begun.set(node.id, state);
    this.#write({ state, parent, entry: openedAgentEntry({ node, at: now() }) });
  }

  /** A command or a service started: its channel begins, with the command from its `task`. */
  openWork(params: { node: NodeRecord; task: TaskInfo }): void {
    const { node, task } = params;

    if ((node.kind !== 'command' && node.kind !== 'service') || this.#begun.has(node.id)) return;

    const parent = this.#parentOf(node);

    if (!parent) return;

    const state: Begun = { kind: 'bytes', offset: 0, broken: false, written: 0 };

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
    this.#closing.set(node.id, state);
    this.#write({ state, entry: closedEntry({ node, at: now(), cursor, task }) });
  }

  #updateAgent(node: NodeRecord): void {
    const state = this.#begun.get(node.id);

    if (state?.kind !== 'sequence' || !isOpenState(node.state)) return;

    this.#text.flush(node.id);
    this.#write({ state, entry: updatedEntry({ node, at: now(), position: state.next }) });
    state.next += 1;
  }

  /** Stores the text a window held, as one `text_delta` event that merges the ones it held. */
  #storeText(params: { channel: string; text: PendingText }): void {
    const { channel, text } = params;
    const state = this.#sequenceState(channel);

    if (!state) return;

    this.#writeEvent({
      channel,
      state,
      event: { seq: text.seq, type: 'text_delta', text: text.text },
      at: text.at,
      messageId: text.messageId,
      ...(text.lastSeq > text.seq && { lastSeq: text.lastSeq }),
    });
  }

  /** Queues the `event` entry (or the marker for one too large) for the channel's next place. */
  #writeEvent(params: {
    channel: string;
    state: Begun & { kind: 'sequence' };
    event: EntryEvent;
    at: number;
    messageId: MessageId | undefined;
    lastSeq?: number;
  }): void {
    const { state, ...entry } = params;
    let built: ChannelEntry;

    try {
      built = eventEntry({ ...entry, cursor: sequenceCursor(state.next) });
    } catch (caughtError) {
      // An event JSON cannot carry (a BigInt in a tool's artifact): the channel cannot hold the run
      // whole, so it takes no more entries, as after a write that failed. Queued with the writes, so
      // what was told before it is stored first, and this listener never throws into the run.
      this.#written = this.#written.then(() => {
        this.#break({ channel: entry.channel, state, error: caughtError });
      });

      return;
    }

    this.#write({ state, entry: built });
    state.next += 1;
  }

  /** The node ended: its `closed` entry waits for the run's `done` (`#ending`), or the end of this step. */
  #closeAgent(node: NodeRecord): void {
    const state = this.#begun.get(node.id);

    if (state?.kind !== 'sequence') return;

    this.#begun.delete(node.id);
    this.#closing.set(node.id, state);
    this.#ending.set(node.id, { state, node });
    queueMicrotask(() => {
      this.#writeClose(node.id);
    });
  }

  /** Stores the text waiting for `channel`, then its `closed` entry: what an ended agent's channel ends with. */
  #writeClose(channel: string): void {
    const ending = this.#ending.get(channel);

    if (!ending) return;

    const { state, node } = ending;

    // The text first, while the channel still takes entries (`#sequenceState`); then it is closed.
    this.#text.flush(channel);
    this.#ending.delete(channel);
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
      if (!state.broken) await this.#store({ state, entry, parent });

      // Stored, or given up on: either way nothing more is written to a channel that closed.
      if (entry.type === 'closed') this.#closing.delete(entry.channel);
    });
  }

  /** Appends `entry` and tells the channel's followers; a failure marks the channel, never throws. */
  async #store(params: {
    state: Begun;
    entry: ChannelEntry;
    parent?: { channel?: string; state?: Begun } | undefined;
  }): Promise<void> {
    const { state, entry, parent } = params;

    try {
      const stored = { ...entry, ...this.#spawnedAt(parent) };

      await this.#storage.log(entry.channel).append(stored);
      state.stored = entry.cursor;
      this.#followers.tell({
        channel: entry.channel,
        event: { type: 'stored', entry: stored, ordinal: state.written },
      });
      state.written += 1;
    } catch (caughtError) {
      this.#break({ channel: entry.channel, state, error: caughtError });
    }
  }

  /** `channel` takes no more entries: its followers are told, and the failure is reported once. */
  #break(params: { channel: string; state: Begun; error: unknown }): void {
    const { channel, state, error } = params;

    state.broken = true;
    this.#followers.tell({ channel, event: { type: 'failed' } });
    this.#fail(error);
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

import type { StoreError } from '@sheavly/core/errors/store.errors';
import type { ChannelEntry, ChannelLog } from '@sheavly/core/store/store.types';
import type { CallId } from '@sheavly/protocol/message/message.types';
import type { ModelEffort, ModelId } from '@sheavly/protocol/model/model.types';
import type { NodeId } from '@sheavly/protocol/node/node.types';
import type { RunOutcome, SessionId } from '@sheavly/protocol/session/session.types';
import type { StateOf } from '@sheavly/protocol/status/status.types';
import type { TaskId } from '@sheavly/protocol/task/task.types';
import type { TreeView } from '@sheavly/protocol/tree/tree.types';

/** Where a node is: the protocol's one lifecycle, whatever its kind. */
export type NodeState = StateOf<'node'>;

/** The kinds the harness has. An extension's kind, `<extension>.<name>`, is one too. */
export type NodeKind = 'agent' | 'command' | 'service' | `${string}.${string}`;

/**
 * What the registry keeps of one node. Every method that returns a node hands out a copy, never
 * the live record. The entries of a channel are not copied per reader: they are shared, and read
 * only by contract (`ReadableChannel` has no way to append).
 */
export type NodeRecord = {
  id: NodeId;
  kind: NodeKind;
  /**
   * The node that started this one, and so the one that owns it: a caller sees the nodes it
   * started and those nobody did. None for the main agent.
   */
  parent?: NodeId;
  title: string;
  /** What an agent last said it was doing (`report_status`). */
  status?: string;
  state: NodeState;
  startedAt: number;
  endedAt?: number;
  /** The tool call, in the parent's history, that started it. */
  spawnedBy?: CallId;
  modelId?: ModelId;
  effort?: ModelEffort;
  /** How an agent's last run ended: set once a run finishes, whether it went idle or ended. */
  lastOutcome?: RunOutcome;
};

/** What starts a node. A node always starts `running`, or as it was, when restored. */
export type OpenNode = {
  kind: NodeKind;
  parent?: NodeId | undefined;
  title: string;
  spawnedBy?: CallId | undefined;
  modelId?: ModelId | undefined;
  effort?: ModelEffort | undefined;
};

/** A node as a stored conversation left it, to put back as it was. */
export type RestoredNode = OpenNode & {
  state: NodeState;
  startedAt: number;
  endedAt?: number | undefined;
  lastOutcome?: RunOutcome | undefined;
  status?: string | undefined;
};

/**
 * One entry of a channel: the node as it was after the change. `opened` is the first entry of a
 * node's channel, `closed` its last; `updated` is a change while it lives (idle, running again, its
 * status or model). The tree channel carries every node's entries.
 */
export type NodeEntry = {
  /** The entry's position in its channel: 0, 1, 2, … with no gap. */
  cursor: number;
  at: number;
  type: 'opened' | 'updated' | 'closed';
  node: NodeRecord;
};

/**
 * Where a conversation's node channels are kept, when they are: the log of a channel by name (a
 * node's id), and who to tell, once, when a write fails. A failed write leaves that channel as it
 * was (it takes no more entries, so a log never reads as whole with an entry missing) and the run
 * goes on: reopening the conversation closes the channel as `lost`.
 */
export type NodeChannelStorage = {
  log: (channel: string) => ChannelLog;
  onFailure?: ((failure: StoreError) => void) | undefined;
  /**
   * What the stored tree channel left when the conversation was reopened (`TreeChannelWriter.readStored`):
   * the tree writer goes on from it. Absent for a new conversation, and for one that has no tree
   * channel stored yet.
   */
  resumedTree?: ResumedTree | undefined;
};

/**
 * The stored tree channel as a reopened conversation finds it: where it stands (`next` is the
 * position of the next entry, `last` the entry before it) and the tree its entries build, or why it
 * cannot be gone on from (a damaged entry, a channel that ends in `closed`, a disk that fails), in
 * which case the tree channel is not written and the failure is told.
 */
export type ResumedTree =
  { next: number; last: { cursor: string; at: number }; tree: TreeView } | { failure: StoreError };

/**
 * What a follower of a stored channel is told, in the order the writes happened: an entry the
 * store took, with its place in the channel's log (`ordinal`: 0 for the first, with no gap, so
 * what a reader of the store holds and what a follower hears can be joined without a gap or a
 * repeat), or that the channel takes no more entries: it failed, or, for the tree channel, its
 * writer was stopped because the conversation closed.
 */
export type ChannelEvent =
  { type: 'stored'; entry: ChannelEntry; ordinal: number } | { type: 'failed' };

/** What `closeLostChannels` did: the channels it closed, and the ones it could not. */
export type LostChannels = {
  /** Channels that had no `closed` entry and now end as `lost`. */
  closed: string[];
  /** Channels with no `closed` entry that the store refused one for, being at a limit. */
  full: string[];
  /**
   * Channels the store could not read or close (a damaged or unreadable file, a disk that failed),
   * each with why. They were left as they were, and the others were repaired.
   */
  failed: { channel: string; failure: StoreError }[];
};

/** Where a stored channel stood: the channel and the cursor of its newest entry. */
export type ChannelPosition = { channel: string; cursor: string };

/** Where an entry of the conversation's tree channel is, and when it was written. */
export type TreeStamp = { position: number; at: number };

/** Where to start reading a channel: its first entry, only what comes, or a position. */
export type ChannelStart = 'start' | 'now' | number;

/**
 * What a command to an open node reaches (`NodeCommands.target`): the main agent, whose cancel is
 * the conversation's stop and which takes the user's messages; a sub-agent, stopped through its
 * task; a command or a service, through its task; or a kind nothing can cancel (an extension's).
 */
export type NodeTarget =
  | { kind: 'main-agent'; sessionId: SessionId }
  | { kind: 'sub-agent'; sessionId: SessionId; taskId: TaskId }
  | { kind: 'work'; taskId: TaskId }
  | { kind: 'other'; nodeKind: NodeKind };

/** Reads a channel's entries; the registry alone appends to it. */
export type ReadableChannel = {
  /** The position the next entry will have. */
  readonly next: number;
  /** The entries from `from`, oldest first. Throws `cursor_out_of_range` past either end. */
  read: (from: number) => NodeEntry[];
  /** Calls `listener` for the entries from `start` and then each new one. Returns a stop. */
  follow: (listener: (entry: NodeEntry) => void, start?: ChannelStart) => () => void;
};

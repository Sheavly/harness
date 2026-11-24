import type { OutputStore } from '../output/output.types.js';
import type { ChannelHead } from '@sheavly/protocol/channel/channel.types';
import type { ConversationId } from '@sheavly/protocol/server/server.types';
import type { HistoryRecord } from '@sheavly/protocol/history/history.types';
import type { SessionId } from '@sheavly/protocol/session/session.types';
import type { StoredConversation } from '@sheavly/protocol/store/store.types';
import type { StreamEntry } from '@sheavly/protocol/stream/stream.types';

/**
 * One conversation's stored entries, in `seq` order with no gaps. `append` takes the next entry
 * and rejects with a `StoreError` for any other `seq`, so a lost write can never be hidden by a
 * later one. `read` yields the entries from `from` (default 0) on. Either rejects with a
 * `StoreError` when storage fails: a store never drops an entry silently.
 */
export type EntryStore = {
  append(entry: StreamEntry): Promise<void>;
  read(from?: number): AsyncIterable<StreamEntry>;
};

/**
 * One session's durable history: an append-only log of entries, each with a permanent `seq`
 * starting at 0 with no gaps. `append` takes the next records in order and rejects with a
 * `StoreError` for any other `seq`, so a lost write can never be hidden by a later one; a crash
 * may keep only the first records of one `append`, never a gap. `read` yields the records from
 * `from` (default 0). Entries are never rewritten or removed.
 */
export type HistoryLog = {
  append(records: readonly HistoryRecord[]): Promise<void>;
  read(from?: number): AsyncIterable<HistoryRecord>;
};

/**
 * One entry of a channel as it is stored: what every entry has (the channel it belongs to, its
 * cursor, its type and when it was written) and whatever else the type holds. The store keeps an
 * entry as it was given and never looks past those four fields.
 */
export type ChannelEntry = ChannelHead & { at: number } & Record<string, unknown>;

/**
 * Where a read of a channel starts: its first entry, its last `tail` entries (0 or more; fewer when
 * it has fewer), or the entries after the one with this cursor, so a reader that kept the last
 * cursor it saw gets what it has not.
 */
export type ChannelFrom = 'start' | { tail: number } | { after: string };

/**
 * One channel's durable log: the entries of a node, or of the conversation's `tree`, in the order
 * they were written, each with the cursor of its channel. A channel is made by its first entry,
 * which is `opened`, and ends with `closed`; between them the cursor goes on from the one before
 * (`channelAppendEntry` is the rule, and every store applies it, writing the entry it returns). A
 * log is append-only: nothing
 * is rewritten or removed until the conversation is deleted. Which entry types a channel holds is
 * the business of whoever writes them, and so is whether its cursors are of the kind its node's
 * kind allows (an agent's are numbered, a command's are bytes): a store checks one kind is kept,
 * not which.
 *
 * `append` rejects with `invalid` for an entry the store could not read back (not the shape of a
 * channel's entry, or over `MAX_CHANNEL_ENTRY_CHARS`), with `out_of_order` for one that cannot
 * come next (a gap, a repeat, a second `opened`, anything after `closed`, another channel's),
 * with `quota` when the channel or its conversation is past a limit, and with `failed` when
 * storage fails. A channel that already holds entries and refused one for a limit takes no more,
 * and a file keeps that across a restart, so a writer cannot leave a log that is missing an entry
 * and goes on (a byte cursor may jump, so nothing else would stop it). A reader is not told: it
 * reads what the channel holds. A failed write may have reached the storage: a retry of the same
 * sequence cursor is `out_of_order`, and one of a byte cursor can store the entry twice, so a
 * writer that retries checks first.
 *
 * `read` rejects with `cursor_out_of_range` for an `after` that is not a cursor or not the cursor
 * of an entry the channel holds, and for a `tail` that is not a whole number from 0 to `MAX_TAIL`
 * (a store keeps that many entries to answer it); a channel nothing was written to reads as empty
 * from `start` or a `tail`. A byte channel's cursor is an offset into its output, which the output
 * store serves, and several entries can share an offset: `after` that cursor starts after the
 * first of them. A log holds only the entries it was given, so a cursor between two of them is
 * not one it can continue from.
 */
export type ChannelLog = {
  append(entry: ChannelEntry): Promise<void>;
  read(from?: ChannelFrom): AsyncIterable<ChannelEntry>;
};

/**
 * What a store keeps of one conversation's channels at most: the bytes of one channel's log, the
 * bytes of all of them, and how many channels there are. A store that has limits takes them in this
 * form; an `append` past one rejects with `quota`. An entry costs its line: its JSON and the line
 * break, so a limit means the same in a file and in memory.
 */
export type ChannelLimits = {
  channelBytes: number;
  conversationBytes: number;
  conversationChannels: number;
};

/**
 * One JSON document kept with a conversation, for an owner that knows what is in it and keeps its
 * own schema. `load` gives what is stored, `undefined` when nothing is. `update` replaces it with
 * what `change` makes of the current one, one change at a time, so two agents changing it at once
 * never erase each other; `change` returning `undefined` stores nothing. Either rejects with a
 * `StoreError` when storage fails.
 */
export type DocumentStore = {
  load(): Promise<unknown>;
  update(change: (current: unknown) => unknown): Promise<void>;
};

/**
 * Where a user's past conversations are kept: generic (no workspace, no coding tool), so any
 * harness project can keep its chats. Every method rejects with a `StoreError` when storage fails.
 */
export type ConversationStore = {
  /** Conversation `id`'s entries; the conversation exists in the store from its first `append`. */
  entries(id: ConversationId): EntryStore;
  /**
   * The durable history log of conversation `id`'s main session, or of sub-agent `session`'s when
   * given. `session` is an id the registry made; a store that names a file after it must refuse
   * one that is not safe to use as a name rather than trust it.
   */
  history(params: { id: ConversationId; session?: SessionId | undefined }): HistoryLog;
  /**
   * The durable log of one channel of conversation `id`: a node's id, or `tree`. The same log for
   * every call with one `id` and `channel`. A store that names a file after `channel` must refuse
   * a name that is not safe to use as one rather than trust it, and the log goes when the
   * conversation is deleted.
   */
  channel(params: { id: ConversationId; channel: string }): ChannelLog;
  /**
   * The names of the channels conversation `id` has stored (a channel exists from its first
   * entry), in no order a caller may rely on. A conversation that stored none, or that is not
   * stored, has none. It is what a reopened conversation looks through to find a channel whose
   * node never closed.
   */
  channels(id: ConversationId): Promise<string[]>;
  /**
   * Conversation `id`'s shell state (`shell.json`): where its agents work from. The same document
   * for every call with one `id`, so the main session and its sub-agents share it, and kept with
   * the conversation, so it survives a restart and goes when the conversation is deleted.
   */
  shell(id: ConversationId): DocumentStore;
  /**
   * Conversation `id`'s complete command output. Kept with the conversation, so it survives a
   * reopen and goes when the conversation is deleted; another conversation's references are
   * `not_found` in it.
   */
  outputs(id: ConversationId): OutputStore;
  /**
   * Conversation `id`'s pending queue (`queue.json`): lines a person queued behind a running
   * prompt. Kept apart from history so it never reaches model input or summaries, and survives a
   * restart; reopening never sends it. Goes when the conversation is deleted.
   */
  queue(id: ConversationId): DocumentStore;
  /** Every stored conversation's index entry, oldest first. */
  list(): Promise<StoredConversation[]>;
  /** Writes `conversation`'s index entry, replacing the one stored for its `id`. */
  writeIndex(conversation: StoredConversation): Promise<void>;
  /**
   * Removes the conversation, its entries, its history, its sub-agents' histories and its index
   * entry. A conversation not stored is fine.
   */
  delete(id: ConversationId): Promise<void>;
};

import path from 'node:path';
import type { OutputStore } from '@sheavly/core/output/output.types';
import type {
  ChannelLimits,
  ChannelLog,
  ConversationStore,
  DocumentStore,
  EntryStore,
  HistoryLog,
} from '@sheavly/core/store/store.types';
import type { LogSink } from '@sheavly/logger/logger/logger.types';
import { conversationIdSchema } from '@sheavly/protocol/server/server.validator';
import type { ConversationId } from '@sheavly/protocol/server/server.types';
import type { SessionId } from '@sheavly/protocol/session/session.types';
import type { StoredConversation } from '@sheavly/protocol/store/store.types';
import { StorageFileError } from '../errors/storage.errors.js';
import { readJsonFile, writeJsonFile } from '../json-file/json-file.helper.js';
import { OrderedAppends } from '../jsonl-file/ordered-appends.service.js';
import { storedConversationIndexSchema } from '../legacy-effort/legacy-effort.validator.js';
import { listFolderNames } from '../listing/listing.helper.js';
import type { FileProblem, ListedFile } from '../listing/listing.types.js';
import { splitListed } from '../listing/listing.utils.js';
import { assertSafeRoot, removeFolder } from '../safe-path/safe-path.helper.js';
import { FileOutputStore } from '../output-store/output-store.service.js';
import {
  CONVERSATIONS_FOLDER,
  DEFAULT_CHANNEL_LIMITS,
  INDEX_FILE,
  LOG_FILE,
  OUTPUTS_FOLDER,
  QUEUE_FILE,
  SHELL_FILE,
} from './conversation-store.constants.js';
import { asStoreError, conversationFolder, historyLogFile } from './conversation-store.utils.js';
import { ConversationChannels } from './conversation-channels.service.js';
import { documentStoreOf } from './document-store.helper.js';
import { EntryFile } from './entry-file.service.js';
import { HistoryFile } from './history-file.service.js';

/**
 * A workspace's conversations on disk: `<workspace folder>/conversations/<conversation-id>/`, one
 * folder each, holding `index.json`, `stream.jsonl`, `history.jsonl`, `agents/<session-id>.history.jsonl`
 * and `channels/<channel>.jsonl`.
 * Everything is named by an id, so no title or path from a person reaches a file name, and
 * deleting a conversation deletes its folder and nothing else.
 *
 * It rejects with a `StoreError`, as the `ConversationStore` contract says, and its messages name
 * the file and never what it holds: a conversation is private. One process owns a workspace's
 * conversations at a time; the stream's order rests on that (see `EntryFile`).
 */
export class FileConversationStore implements ConversationStore {
  readonly #folder: string;
  readonly #onProblem: (problem: FileProblem) => void;
  readonly #streams = new Map<ConversationId, EntryFile>();
  readonly #shells = new Map<ConversationId, DocumentStore>();
  readonly #outputs = new Map<ConversationId, FileOutputStore>();
  readonly #queues = new Map<ConversationId, DocumentStore>();
  /** Each conversation's log writer, so every line asked for is written in the order asked. */
  readonly #logAppends = new Map<ConversationId, OrderedAppends>();
  /** Deleted conversations: a conversation id is never reused, so a late log line is dropped. */
  readonly #deleted = new Set<ConversationId>();
  /** Each session's history log, by `<conversation>/<session>`, so one queue orders its appends. */
  readonly #logs = new Map<string, HistoryFile>();
  /** Each conversation's channel logs, held to one set of limits. */
  readonly #channels = new Map<ConversationId, ConversationChannels>();
  readonly #channelLimits: ChannelLimits;

  /**
   * `folder` is the workspace's folder (`<profile folder>/workspaces/<workspace-key>`), which an
   * app passes in. `onProblem` is told about each conversation `list` could not use, since the
   * list itself has no place for it: a typo in one index must not hide the others, nor vanish.
   * `limits` is what a conversation's channels may hold; what is not given is `DEFAULT_CHANNEL_LIMITS`.
   */
  constructor(params: {
    folder: string;
    onProblem: (problem: FileProblem) => void;
    limits?: Partial<ChannelLimits>;
  }) {
    this.#folder = path.join(assertSafeRoot(params.folder), CONVERSATIONS_FOLDER);
    this.#onProblem = params.onProblem;
    this.#channelLimits = { ...DEFAULT_CHANNEL_LIMITS, ...params.limits };
  }

  entries(id: ConversationId): EntryStore {
    const folder = this.#folderOf(id);
    const existing = this.#streams.get(id);

    if (existing) return existing;

    const stream = new EntryFile({ folder, conversationId: id });

    this.#streams.set(id, stream);

    return stream;
  }

  history(params: { id: ConversationId; session?: SessionId | undefined }): HistoryLog {
    const { id, session } = params;
    const key = `${id}/${session ?? ''}`;
    const known = this.#logs.get(key);

    if (known) return known;

    const folder = this.#folderOf(id);
    const log = new HistoryFile({ file: historyLogFile({ folder, session }) });

    this.#logs.set(key, log);

    return log;
  }

  channel(params: { id: ConversationId; channel: string }): ChannelLog {
    return this.#channelsOf(params.id).logOf(params.channel);
  }

  async channels(id: ConversationId): Promise<string[]> {
    try {
      return await this.#channelsOf(id).names();
    } catch (caughtError) {
      throw asStoreError(caughtError);
    }
  }

  #channelsOf(id: ConversationId): ConversationChannels {
    const known = this.#channels.get(id);
    const channels =
      known ??
      new ConversationChannels({ folder: this.#folderOf(id), limits: this.#channelLimits });

    this.#channels.set(id, channels);

    return channels;
  }

  /**
   * Where conversation `id`'s log entries go: its `log.jsonl`, beside the failures its stream
   * records. Entries are written in the order they are given, even when the caller does not wait
   * for each (one writer per conversation, however often this is called), and the folder is made
   * if the conversation has not stored anything yet. Once the conversation is deleted a late
   * entry is dropped, so a failure while it is closing cannot bring its folder back.
   */
  logSink(id: ConversationId): LogSink {
    const known = this.#logAppends.get(id);
    const appends = known ?? new OrderedAppends({ file: path.join(this.#folderOf(id), LOG_FILE) });

    this.#logAppends.set(id, appends);

    return (entry) => appends.append({ value: entry, unless: () => this.#deleted.has(id) });
  }

  shell(id: ConversationId): DocumentStore {
    const known = this.#shells.get(id);

    if (known) return known;

    // One store per conversation, so every agent's change goes through its one queue.
    const shell = documentStoreOf(path.join(this.#folderOf(id), SHELL_FILE));

    this.#shells.set(id, shell);

    return shell;
  }

  /** Conversation `id`'s output store; after `delete(id)` it is the retired one, never a new one. */
  outputs(id: ConversationId): OutputStore {
    return this.#outputStore(id);
  }

  #outputStore(id: ConversationId): FileOutputStore {
    const known = this.#outputs.get(id);

    if (known) return known;

    const store = new FileOutputStore({ folder: path.join(this.#folderOf(id), OUTPUTS_FOLDER) });

    this.#outputs.set(id, store);

    return store;
  }

  queue(id: ConversationId): DocumentStore {
    const known = this.#queues.get(id);

    if (known) return known;

    const queue = documentStoreOf(path.join(this.#folderOf(id), QUEUE_FILE));

    this.#queues.set(id, queue);

    return queue;
  }

  /**
   * The conversations that have an index, oldest first (then by id, so the order is the same on
   * every system). A folder without an `index.json` is a conversation whose stream has started and
   * whose index is not written yet, and is not listed. Each folder that is not a usable
   * conversation goes to `onProblem` and the rest are listed.
   */
  async list(): Promise<StoredConversation[]> {
    try {
      const names = await this.#conversationNames();
      const { items, problems } = splitListed(
        await Promise.all(names.map((name) => this.#readListed(name))),
      );

      for (const problem of problems) this.#onProblem(problem);

      return items.sort((a, b) => a.startedAt - b.startedAt || (a.id < b.id ? -1 : 1));
    } catch (caughtError) {
      throw asStoreError(caughtError);
    }
  }

  async writeIndex(conversation: StoredConversation): Promise<void> {
    const file = path.join(this.#folderOf(conversation.id), INDEX_FILE);

    try {
      await writeJsonFile({ file, value: conversation });
    } catch (caughtError) {
      throw asStoreError(caughtError);
    }
  }

  async delete(id: ConversationId): Promise<void> {
    const folder = this.#folderOf(id);

    // Made if need be: a store that was never opened must still be the retired one afterwards.
    const outputs = this.#outputStore(id);

    // Before the folder goes: a log entry written meanwhile must not make it again.
    this.#deleted.add(id);

    try {
      // Lines already asked for are written or dropped by now, so none is in flight to make it.
      await this.#logAppends.get(id)?.settled();
      // First: a command still printing must not recreate the folder that is about to go.
      await outputs.retire();
      await this.#streams.get(id)?.forget();
      await this.#channels.get(id)?.forget();
      await removeFolder({ root: this.#folder, folder });
      await this.#forgetLogs(id);
      this.#streams.delete(id);
      this.#channels.delete(id);
      this.#shells.delete(id);
      this.#queues.delete(id);
      // The retired store stays: a new `outputs(id)` must not hand out a store that could make
      // the folder again. A conversation id is a fresh UUID each time, so it is never reused.
    } catch (caughtError) {
      // Nothing was deleted, so the conversation keeps storing output and its log.
      outputs.resume();
      this.#deleted.delete(id);
      throw asStoreError(caughtError);
    }
  }

  async #forgetLogs(id: ConversationId): Promise<void> {
    for (const [key, log] of this.#logs) {
      if (!key.startsWith(`${id}/`)) continue;

      await log.forget();
      this.#logs.delete(key);
    }
  }

  #folderOf(id: ConversationId): string {
    return conversationFolder({ conversations: this.#folder, id });
  }

  /** The folders that could be conversations: folders only, not hidden, in a fixed order. */
  async #conversationNames(): Promise<string[]> {
    return listFolderNames({ folder: this.#folder });
  }

  /** One folder of the listing: its index, nothing when it has none yet, or what is wrong with it. */
  async #readListed(name: string): Promise<ListedFile<StoredConversation>> {
    const folder = path.join(this.#folder, name);
    const id = conversationIdSchema.safeParse(name);

    if (!id.success) {
      return {
        problem: {
          file: folder,
          message:
            'its name is not a conversation id, a lowercase UUID. Nothing here is named by hand',
        },
      };
    }

    try {
      const stored = await readJsonFile({
        file: path.join(folder, INDEX_FILE),
        schema: storedConversationIndexSchema,
        holdsSecrets: true,
      });

      if (!stored) return undefined;

      return stored.id === id.data
        ? { item: stored }
        : {
            problem: {
              file: path.join(folder, INDEX_FILE),
              message: `it holds the conversation ${stored.id}, but its folder is named for ${id.data}: a copy or a rename by hand`,
            },
          };
    } catch (caughtError) {
      // Only an index that cannot be used is a problem to list; any other failure is not ours to hide.
      if (caughtError instanceof StorageFileError) {
        return { problem: { file: caughtError.file, message: caughtError.message } };
      }

      throw caughtError;
    }
  }
}

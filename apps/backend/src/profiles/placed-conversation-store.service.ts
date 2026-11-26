import { StoreError } from '@sheavly/core/errors/store.errors';
import type { OutputStore } from '@sheavly/core/output/output.types';
import type {
  ChannelFrom,
  ChannelLog,
  ChannelSummary,
  ConversationStore,
  DocumentStore,
  EntryStore,
  HistoryLog,
} from '@sheavly/core/store/store.types';
import { assertChannelName } from '@sheavly/core/store/store.utils';
import type { LogSink } from '@sheavly/logger/logger/logger.types';
import type { FileConversationStore } from '@sheavly/storage/conversation-store/conversation-store.service';
import type { ProfileId } from '@sheavly/protocol/profile/profile.types';
import type { ConversationId } from '@sheavly/protocol/server/server.types';
import type { SessionId } from '@sheavly/protocol/session/session.types';
import type { StoredConversation } from '@sheavly/protocol/store/store.types';
import type { Placement } from './profiles.types.js';
import type { Profiles } from './profiles.service.js';

/** Where one conversation lives: its placement, and the store of that folder under that profile. */
type Home = { placement: Placement; store: FileConversationStore };

/**
 * The backend's conversations, kept wherever each belongs: under the profile it runs on, in the
 * folder it works in. The host sees one store; this puts every conversation in its own place, so
 * several can run at once on different profiles in different folders, or in one folder.
 *
 * A new conversation is placed once, by `decide`, before anything of it is written; the placement
 * never changes, so its stream, history and index can never end up in two places. One reopened
 * after a restart was never decided in this process: the first read looks through every profile and
 * folder for it. It is not found when nothing kept it, and then there is nothing to read.
 */
export class PlacedConversationStore implements ConversationStore {
  readonly #profiles: Profiles;
  readonly #fallbackWorkspace: string;
  readonly #onProblem: Parameters<Profiles['conversationsFor']>[0]['onProblem'];
  /** Each conversation's home, as a promise so two callers asking at once share one lookup. */
  readonly #homes = new Map<ConversationId, Promise<Home | undefined>>();

  /** `fallbackWorkspace` is the folder a start that names none works in: the backend's own. */
  constructor(params: {
    profiles: Profiles;
    fallbackWorkspace: string;
    onProblem: Parameters<Profiles['conversationsFor']>[0]['onProblem'];
  }) {
    this.#profiles = params.profiles;
    this.#fallbackWorkspace = params.fallbackWorkspace;
    this.#onProblem = params.onProblem;
  }

  /**
   * Places conversation `id` and remembers it: the folder and profile it asked for, else the
   * backend's folder and the profile that folder is bound to or the default (see `Profiles.place`).
   * Rejects with what `place` rejects with. Nothing of the conversation is written before this.
   */
  async decide(params: {
    id: ConversationId;
    asked: { workspace?: string | undefined; profile?: ProfileId | undefined };
  }): Promise<Placement> {
    const { id, asked } = params;
    const placement = await this.#profiles.place({
      workspace: asked.workspace,
      profile: asked.profile,
      fallbackWorkspace: this.#fallbackWorkspace,
    });
    const store = await this.#profiles.conversationsFor({ placement, onProblem: this.#onProblem });

    this.#homes.set(id, Promise.resolve({ placement, store }));

    return placement;
  }

  entries(id: ConversationId): EntryStore {
    return {
      append: async (entry) => (await this.#placed(id)).store.entries(id).append(entry),
      read: (from) => this.#readEntries({ id, from }),
    };
  }

  /** A channel's log, wherever its conversation is kept: written once it is placed, read when kept. */
  channel(params: { id: ConversationId; channel: string }): ChannelLog {
    const { id, channel } = params;

    // At once, as every store does, and not on the first write: a read of a conversation nobody
    // placed would otherwise never look at the name.
    assertChannelName(channel);

    return {
      append: async (entry) =>
        (await this.#placed(id)).store.channel({ id, channel }).append(entry),
      head: () => this.#headOf({ id, channel }),
      read: (from) => this.#readChannel({ id, channel, from }),
    };
  }

  /** The channels a conversation has stored, wherever it is kept; none for one nobody kept. */
  async channels(id: ConversationId): Promise<string[]> {
    const home = await this.#homeOf(id);

    return home ? home.store.channels(id) : [];
  }

  /** What a channel holds, wherever its conversation is kept; nothing for one nobody kept. */
  async #headOf(params: { id: ConversationId; channel: string }): Promise<ChannelSummary> {
    const home = await this.#homeOf(params.id);

    return home ? home.store.channel(params).head() : { count: 0, newest: undefined };
  }

  async *#readChannel(params: {
    id: ConversationId;
    channel: string;
    from: ChannelFrom | undefined;
  }) {
    const { id, channel, from } = params;
    const home = await this.#homeOf(id);

    if (home) yield* home.store.channel({ id, channel }).read(from);
  }

  /**
   * Where conversation `id`'s log entries go: its own `log.jsonl`, wherever it is kept, or
   * `otherwise` when nothing placed or kept it (a failure before it started, an id nobody has).
   */
  logSink(params: { id: ConversationId; otherwise: LogSink }): LogSink {
    const { id, otherwise } = params;

    return async (entry) => {
      const home = await this.#homeForLog(id);

      await (home ? home.store.logSink(id) : otherwise)(entry);
    };
  }

  /**
   * The home of `id` for a log entry: `undefined` when there is none, or when looking for it
   * failed. The entry describes a failure, often of these very stores, and must reach a file
   * anyway: it goes where an unplaced conversation's goes.
   */
  async #homeForLog(id: ConversationId): Promise<Home | undefined> {
    try {
      return await this.#homeOf(id);
    } catch (caughtError) {
      // Any error of the lookup (a profile folder that cannot be read) means no known home; what
      // is not an error is not ours to hide.
      if (caughtError instanceof Error) return undefined;
      throw caughtError;
    }
  }

  shell(id: ConversationId): DocumentStore {
    return {
      load: async () => (await this.#placed(id)).store.shell(id).load(),
      update: async (change) => (await this.#placed(id)).store.shell(id).update(change),
    };
  }

  outputs(id: ConversationId): OutputStore {
    const placed = () => this.#placed(id).then((home) => home.store.outputs(id));

    return {
      create: async () => (await placed()).create(),
      log: async (ref) => (await placed()).log(ref),
      read: async (params) => (await placed()).read(params),
      search: async (params) => (await placed()).search(params),
    };
  }

  queue(id: ConversationId): DocumentStore {
    return {
      load: async () => (await this.#placed(id)).store.queue(id).load(),
      update: async (change) => (await this.#placed(id)).store.queue(id).update(change),
    };
  }

  history(params: { id: ConversationId; session?: SessionId | undefined }): HistoryLog {
    const placed = async () => (await this.#placed(params.id)).store.history(params);

    return {
      append: async (records) => (await placed()).append(records),
      read: (from) => this.#readHistory({ ...params, from }),
    };
  }

  async *#readHistory(params: {
    id: ConversationId;
    session?: SessionId | undefined;
    from: number | undefined;
  }) {
    const home = await this.#homeOf(params.id);

    if (home) yield* home.store.history(params).read(params.from);
  }

  /** Every kept conversation of every profile and folder, oldest first. */
  async list(): Promise<StoredConversation[]> {
    const every = await this.#profiles.everyStore({ onProblem: this.#onProblem });
    const lists = await Promise.all(every.map(({ store }) => store.list()));

    return lists.flat().sort((a, b) => a.startedAt - b.startedAt || (a.id < b.id ? -1 : 1));
  }

  async writeIndex(conversation: StoredConversation): Promise<void> {
    await (await this.#placed(conversation.id)).store.writeIndex(conversation);
  }

  async delete(id: ConversationId): Promise<void> {
    const home = await this.#homeOf(id);

    await home?.store.delete(id);
    this.#homes.delete(id);
  }

  async *#readEntries(params: { id: ConversationId; from: number | undefined }) {
    const { id, from } = params;
    const home = await this.#homeOf(id);

    if (home) yield* home.store.entries(id).read(from);
  }

  /** The home of `id`, or a `StoreError`: a conversation nobody placed is not written anywhere. */
  async #placed(id: ConversationId): Promise<Home> {
    const home = await this.#homeOf(id);

    if (!home) {
      throw new StoreError({
        reason: 'failed',
        message: `Conversation ${id} has no place: it was never started here, and nothing kept it`,
      });
    }

    return home;
  }

  /** The home of `id`: where it was decided, else wherever it was kept; `undefined` when neither. */
  async #homeOf(id: ConversationId): Promise<Home | undefined> {
    const known = this.#homes.get(id);

    if (known) return known;

    const search = this.#find(id);

    this.#homes.set(id, search);

    try {
      const home = await search;

      // Not found now does not mean never: it may be kept before the next ask.
      if (!home) this.#homes.delete(id);

      return home;
    } catch (caughtError) {
      this.#homes.delete(id);
      throw caughtError;
    }
  }

  /** Looks through every profile and folder for a kept conversation `id`. */
  async #find(id: ConversationId): Promise<Home | undefined> {
    for (const { placement, store } of await this.#profiles.everyStore({
      onProblem: this.#onProblem,
    })) {
      if ((await store.list()).some((conversation) => conversation.id === id)) {
        return { placement, store };
      }
    }

    return undefined;
  }
}

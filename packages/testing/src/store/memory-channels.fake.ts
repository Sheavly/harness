import { StoreError } from '@sheavly/core/errors/store.errors';
import type {
  ChannelEntry,
  ChannelFrom,
  ChannelLimits,
  ChannelLog,
} from '@sheavly/core/store/store.types';
import {
  assertChannelName,
  channelAppendEntry,
  channelFromProblem,
} from '@sheavly/core/store/store.utils';
import type { ConversationId } from '@sheavly/protocol/server/server.types';

/** What a limit that is not set allows: everything. */
const UNLIMITED: ChannelLimits = {
  channelBytes: Number.POSITIVE_INFINITY,
  conversationBytes: Number.POSITIVE_INFINITY,
  conversationChannels: Number.POSITIVE_INFINITY,
};

/** What an entry costs: its line in a file, so a limit means the same in memory as on a disk. */
function sizeOf(entry: ChannelEntry): number {
  return Buffer.byteLength(JSON.stringify(entry)) + 1;
}

/**
 * Test-only: the channel logs of a `MemoryConversationStore`, held to the rules of a real store:
 * `channelAppendEntry` for what may be appended, what may come next and the entry that is kept, a
 * limit refused with `quota` (and a channel that holds entries then refuses everything, so it is
 * never read as whole), `cursor_out_of_range` for a read after a cursor it does not hold. `assertWritable` is the store's way of failing a write on request.
 */
export class MemoryChannels {
  readonly #logs = new Map<string, ChannelEntry[]>();
  readonly #bytes = new Map<string, number>();
  /** The channels that refused an entry for a limit: they take no more. */
  readonly #full = new Set<string>();
  readonly #limits: ChannelLimits;
  readonly #assertWritable: () => void;

  constructor(params: { limits?: Partial<ChannelLimits> | undefined; assertWritable: () => void }) {
    this.#limits = { ...UNLIMITED, ...params.limits };
    this.#assertWritable = params.assertWritable;
  }

  /** The log of `channel` in conversation `id`; throws for a name that is not a node id or the tree. */
  logOf(params: { id: ConversationId; channel: string }): ChannelLog {
    const { id, channel } = params;

    assertChannelName(channel);

    return {
      append: async (entry) => this.#append({ id, channel, entry }),
      read: (from = 'start') => this.#read({ key: keyOf({ id, channel }), from }),
    };
  }

  /** The channels conversation `id` has stored: each exists from its first stored entry. */
  namesOf(id: ConversationId): string[] {
    return [...this.#logs.keys()]
      .filter((key) => key.startsWith(`${id}/`))
      .map((key) => key.slice(id.length + 1));
  }

  /** Forgets every channel of conversation `id`. */
  delete(id: ConversationId): void {
    for (const key of [...this.#logs.keys()]) {
      if (!key.startsWith(`${id}/`)) continue;

      this.#logs.delete(key);
      this.#bytes.delete(key);
      this.#full.delete(key);
    }
  }

  #append(params: { id: ConversationId; channel: string; entry: ChannelEntry }): void {
    const { id, channel } = params;
    const key = keyOf({ id, channel });
    const stored = this.#logs.get(key) ?? [];

    this.#assertWritable();

    const checked = channelAppendEntry({ entry: params.entry, channel, last: stored.at(-1) });

    if ('error' in checked) throw checked.error;

    // What a file keeps is the entry's JSON, so this keeps the copy the check made of it.
    const { entry } = checked;
    const over = this.#full.has(key) ? 'is full' : this.#limitHit({ id, key, entry });

    if (over !== undefined) {
      // Nothing is missing from a channel with no entries: it refuses this one and no more.
      if (stored.length > 0) this.#full.add(key);

      throw new StoreError({
        reason: 'quota',
        message: `Channel ${channel} of conversation ${id} ${over}, so it takes no more entries`,
      });
    }

    this.#logs.set(key, [...stored, entry]);
    this.#bytes.set(key, (this.#bytes.get(key) ?? 0) + sizeOf(entry));
  }

  /** Which limit `entry` would pass, or `undefined` when it fits. */
  #limitHit(params: { id: ConversationId; key: string; entry: ChannelEntry }): string | undefined {
    const { id, key, entry } = params;
    const size = sizeOf(entry);
    const keys = [...this.#logs.keys()].filter((each) => each.startsWith(`${id}/`));
    const conversationBytes = keys.reduce((sum, each) => sum + (this.#bytes.get(each) ?? 0), 0);

    if ((this.#bytes.get(key) ?? 0) + size > this.#limits.channelBytes) return 'is past its size';

    if (conversationBytes + size > this.#limits.conversationBytes) {
      return 'is past its conversation’s size';
    }

    return !this.#logs.has(key) && keys.length >= this.#limits.conversationChannels
      ? 'is one channel too many for its conversation'
      : undefined;
  }

  async *#read(params: { key: string; from: ChannelFrom }): AsyncGenerator<ChannelEntry> {
    const { key, from } = params;
    const stored = this.#logs.get(key) ?? [];
    const problem = channelFromProblem(from);

    if (problem !== undefined) {
      throw new StoreError({ reason: 'cursor_out_of_range', message: problem });
    }

    if (from === 'start') {
      yield* stored.map((entry) => structuredClone(entry));

      return;
    }

    if ('tail' in from) {
      yield* stored.slice(Math.max(0, stored.length - from.tail)).map((e) => structuredClone(e));

      return;
    }

    const index = stored.findIndex((entry) => entry.cursor === from.after);

    if (index < 0) {
      throw new StoreError({
        reason: 'cursor_out_of_range',
        message: `Cursor ${from.after} is not one of this channel's entries`,
      });
    }

    yield* stored.slice(index + 1).map((entry) => structuredClone(entry));
  }
}

function keyOf(params: { id: ConversationId; channel: string }): string {
  return `${params.id}/${params.channel}`;
}

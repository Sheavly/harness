import { StoreError } from '@sheavly/core/errors/store.errors';
import type { ConversationStore } from '@sheavly/core/store/store.types';
import type { ConversationChannelName } from '@sheavly/protocol/channel/channel.types';
import type { ConversationId } from '@sheavly/protocol/server/server.types';
import type {
  ChannelPlace,
  EntrySchema,
  ResumedChannel,
  StoredEntry,
} from './stored-channel.types.js';

/**
 * The stored channel `name` of a conversation being reopened: where it stands and the view its
 * entries build, for the writer to go on from. Undefined when none is stored (a conversation kept
 * before the channel was). A channel it cannot go on from, because an entry is damaged, it ends in
 * `closed` (a closed channel takes no more) or the store fails, is a failure instead, so the
 * conversation still reopens and the writer reports why it writes nothing.
 */
export async function readStoredChannel<Entry extends StoredEntry, View>(params: {
  store: Pick<ConversationStore, 'channel' | 'channels'>;
  id: ConversationId;
  name: ConversationChannelName;
  schema: EntrySchema<Entry>;
  empty: View;
  apply: (params: { view: View; entry: Entry }) => View;
}): Promise<ResumedChannel<View> | undefined> {
  const { store, id, name, schema, apply } = params;

  try {
    if (!(await store.channels(id)).includes(name)) return undefined;

    let view = params.empty;
    let last: ChannelPlace | undefined;

    for await (const stored of store.channel({ id, channel: name }).read()) {
      const parsed = schema.safeParse(stored);

      if (!parsed.success || parsed.data.type === 'closed') {
        return {
          failure: new StoreError({
            reason: 'invalid',
            message: `The stored ${name} channel cannot be gone on from: an entry is damaged or it is closed`,
          }),
        };
      }

      view = apply({ view, entry: parsed.data });
      last = { cursor: parsed.data.cursor, at: parsed.data.at };
    }

    return last ? { next: Number(last.cursor.slice(1)) + 1, last, view } : undefined;
  } catch (caughtError) {
    if (!(caughtError instanceof StoreError)) throw caughtError;

    return { failure: caughtError };
  }
}

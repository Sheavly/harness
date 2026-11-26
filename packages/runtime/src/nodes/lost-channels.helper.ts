import type { ChannelEntry, ConversationStore } from '@sheavly/core/store/store.types';
import { toStoreError } from '@sheavly/core/store/store.utils';
import {
  cursorKind,
  cursorNumber,
  isConversationChannel,
} from '@sheavly/protocol/channel/channel.utils';
import type { ConversationId } from '@sheavly/protocol/server/server.types';
import { byteCursor, lostEntry, sequenceCursor } from './node-channel-entries.utils.js';
import type { LostChannels } from './nodes.types.js';

/**
 * Closes, as `lost`, every node channel conversation `id` has stored that never reached its
 * `closed` entry: the server stopped under the node. It is the repair of a reopened conversation,
 * and runs before the conversation's own nodes exist, so every unfinished channel in the store is a
 * previous process's. A channel that already ends in `closed` is left alone, so running it again
 * changes nothing. A channel of the conversation itself (the tree) is not a node's, its writer goes
 * on from what it stored, and it is left alone.
 *
 * The `lost` entry has no outcome and no exit code, since nobody saw the node end, and goes where
 * the channel stood: the next number in a numbered channel, the last offset in a counted one. A
 * channel the store refuses another entry for (it is at a limit) cannot be closed, and is listed
 * in `full`: with no `closed` entry in a conversation that is not live, it already reads as lost.
 *
 * It is a repair of a log that is not the record (the stream is), so it is best effort: a channel
 * the store cannot read or close (a damaged file, a disk that failed) is listed in `failed` with
 * why, and the rest are still repaired, rather than one bad file stopping a conversation from
 * reopening. Only a store that cannot list the channels at all throws.
 */
export async function closeLostChannels(params: {
  store: Pick<ConversationStore, 'channel' | 'channels'>;
  id: ConversationId;
  at: number;
}): Promise<LostChannels> {
  const { store, id, at } = params;
  const result: LostChannels = { closed: [], full: [], failed: [] };

  for (const channel of await store.channels(id)) {
    if (isConversationChannel(channel)) continue;

    try {
      if (await closeOne({ log: store.channel({ id, channel }), channel, at })) {
        result.closed.push(channel);
      }
    } catch (caughtError) {
      const failure = toStoreError({
        error: caughtError,
        message: `Could not close the stored channel of node ${channel}`,
      });

      if (failure.reason === 'quota') result.full.push(channel);
      else result.failed.push({ channel, failure });
    }
  }

  return result;
}

/** Closes `channel` as lost when it does not end in `closed`; whether it did. Throws what the store does. */
async function closeOne(params: {
  log: ReturnType<ConversationStore['channel']>;
  channel: string;
  at: number;
}): Promise<boolean> {
  const { log, channel, at } = params;
  const last = await lastEntryOf(log);

  if (!last || last.type === 'closed') return false;

  await log.append(lostEntry({ channel, cursor: lostCursor(last), at }));

  return true;
}

/** The newest entry of `log`, or none for a channel that holds nothing. */
async function lastEntryOf(log: ReturnType<ConversationStore['channel']>) {
  let last: ChannelEntry | undefined;

  for await (const entry of log.read({ tail: 1 })) last = entry;

  return last;
}

/**
 * Where a channel that ended in `last` stands: the next position of a numbered channel, the same
 * offset of a counted one (nothing was written after what its last entry saw).
 */
function lostCursor(last: ChannelEntry): string {
  const number = cursorNumber(last.cursor);

  return cursorKind(last.cursor) === 'sequence' ? sequenceCursor(number + 1) : byteCursor(number);
}

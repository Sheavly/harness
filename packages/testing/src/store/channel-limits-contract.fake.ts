import { describe, expect, it } from 'vitest';
import type { ChannelLimits, ConversationStore } from '@sheavly/core/store/store.types';
import {
  OPENED,
  UPDATED,
  UPDATED_AGAIN,
  appendAll,
  cursorsOf,
  entryOf,
  first,
  lineBytes,
  past,
  second,
} from './channel-entries.fake.js';

/**
 * Test-only: what every store does at a limit. `make` returns a store with nothing in it that
 * holds a conversation's channels to `limits`. An entry past one is refused with `quota` and not
 * stored, the channel then takes no more (so its log is never read as whole), what it already
 * held reads back, and another conversation is not touched.
 */
export function describeChannelLimits(params: {
  name: string;
  make: (limits: ChannelLimits) => ConversationStore;
}) {
  const { name, make } = params;
  const none = Number.MAX_SAFE_INTEGER;
  // Room for the first three entries of a life, and a little more, whatever a store spends on a line.
  const room = lineBytes(OPENED) + lineBytes(UPDATED) + lineBytes(UPDATED_AGAIN) + 100;

  describe(`${name} at the limits of a conversation’s channels`, () => {
    it('refuses an entry past the size of a channel, then every later one, and keeps what it holds', async () => {
      const store = make({
        channelBytes: room,
        conversationBytes: none,
        conversationChannels: none,
      });
      const log = store.channel({ id: first, channel: 'main' });
      // Over the room by itself, and within what an entry may be.
      const tooBig = past({ ...UPDATED_AGAIN, pad: 'x'.repeat(room) });

      await log.append(OPENED);
      await log.append(UPDATED);

      await expect(log.append(tooBig)).rejects.toMatchObject({
        name: 'StoreError',
        reason: 'quota',
      });

      // This entry fits the room that is left: it is refused because the channel took a refusal,
      // so what the channel holds is never read as whole with an entry missing from it.
      for (const entry of [UPDATED_AGAIN, UPDATED_AGAIN]) {
        await expect(log.append(entry)).rejects.toMatchObject({ reason: 'quota' });
      }

      expect(await cursorsOf({ store })).toEqual(['s0', 's1']);
    });

    it('holds channels written at once to a limit that each passes alone', async () => {
      const second1 = entryOf({ type: 'opened', cursor: 's0', channel: 't1' });
      const second2 = entryOf({ type: 'opened', cursor: 's0', channel: 't2' });
      const store = make({
        channelBytes: none,
        conversationBytes: lineBytes(OPENED) + lineBytes(second1),
        conversationChannels: none,
      });
      const results = await Promise.allSettled(
        [OPENED, second1, second2].map(async (entry) =>
          store.channel({ id: first, channel: entry.channel }).append(entry),
        ),
      );

      expect(results.filter((each) => each.status === 'fulfilled')).toHaveLength(2);
      expect(results.filter((each) => each.status === 'rejected')).toMatchObject([
        { reason: { name: 'StoreError', reason: 'quota' } },
      ]);
    });

    it('holds all of a conversation’s channels to one size, and no other conversation', async () => {
      const other = entryOf({ type: 'opened', cursor: 's0', channel: 't1' });
      const store = make({
        channelBytes: none,
        conversationBytes: lineBytes(OPENED) + lineBytes(other),
        conversationChannels: none,
      });

      await appendAll({ store, entries: [OPENED, other] });

      await expect(
        store.channel({ id: first, channel: 'main' }).append(UPDATED),
      ).rejects.toMatchObject({ reason: 'quota' });

      // Another conversation has its own room.
      await appendAll({ store, conversation: second, entries: [OPENED] });
      expect(await cursorsOf({ store, conversation: second })).toEqual(['s0']);
    });

    it('refuses a channel past the number a conversation may have', async () => {
      const store = make({ channelBytes: none, conversationBytes: none, conversationChannels: 2 });
      const open = (channel: string) => entryOf({ type: 'opened', cursor: 's0', channel });

      await appendAll({ store, entries: [open('main'), open('t1')] });

      await expect(
        store.channel({ id: first, channel: 't2' }).append(open('t2')),
      ).rejects.toMatchObject({ reason: 'quota' });
      expect(await cursorsOf({ store, channel: 't2' })).toEqual([]);

      // A channel that is open goes on, and another conversation has its own count.
      await store.channel({ id: first, channel: 'main' }).append(UPDATED);
      await appendAll({ store, conversation: second, entries: [open('main'), open('t1')] });
    });
  });
}

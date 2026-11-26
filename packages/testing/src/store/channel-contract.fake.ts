import { describe, expect, it } from 'vitest';
import type { ChannelFrom, ConversationStore } from '@sheavly/core/store/store.types';
import { MAX_CHANNEL_ENTRY_CHARS } from '@sheavly/protocol/channel/channel.constants';
import { MAX_TAIL } from '@sheavly/protocol/subscription/subscription.constants';
import {
  CLOSED,
  OPENED,
  UPDATED,
  UPDATED_AGAIN,
  appendAll,
  cursorsOf,
  entryOf,
  first,
  past,
  second,
} from './channel-entries.fake.js';

const LIFE = [OPENED, UPDATED, UPDATED_AGAIN, CLOSED];

/**
 * Test-only: what every store's `ChannelLog` must do, whatever it keeps a conversation in. Call it
 * in a test file with a `make` that returns a store with nothing in it (a new one for each test).
 */
export function describeChannelLog(params: { name: string; make: () => ConversationStore }) {
  const { name, make } = params;

  describe(`${name} as a ChannelLog`, () => {
    it('reads back what it was given, whole, from the start, a tail or a cursor', async () => {
      const store = make();

      await appendAll({ store, entries: LIFE });

      const read = async (from?: ChannelFrom) => cursorsOf({ store, from });

      expect(await read()).toEqual(['s0', 's1', 's2', 's3']);
      expect(await read('start')).toEqual(['s0', 's1', 's2', 's3']);
      expect(await read({ tail: 2 })).toEqual(['s2', 's3']);
      expect(await read({ tail: 0 })).toEqual([]);
      expect(await read({ tail: 10 })).toEqual(['s0', 's1', 's2', 's3']);
      expect(await read({ after: 's1' })).toEqual(['s2', 's3']);
      expect(await read({ after: 's3' })).toEqual([]);

      const stored: unknown[] = [];

      for await (const each of store.channel({ id: first, channel: 'main' }).read()) {
        stored.push(each);
      }

      expect(stored).toEqual(LIFE);
    });

    it('says what a channel holds, without reading it: how many entries and the newest', async () => {
      const store = make();
      const log = store.channel({ id: first, channel: 'main' });
      const newest = (entry: typeof OPENED) => ({
        channel: entry.channel,
        cursor: entry.cursor,
        type: entry.type,
      });

      // A channel nothing was written to holds nothing, and asking does not make it.
      expect(await log.head()).toEqual({ count: 0, newest: undefined });
      expect(await store.channels(first)).toEqual([]);

      for (const [index, entry] of LIFE.entries()) {
        await log.append(entry);
        expect(await log.head()).toEqual({ count: index + 1, newest: newest(entry) });
      }

      // A refused entry changes nothing.
      await expect(log.append(UPDATED_AGAIN)).rejects.toMatchObject({ reason: 'out_of_order' });
      expect(await log.head()).toEqual({ count: 4, newest: newest(CLOSED) });
    });

    it('says what each channel holds apart from the others, a byte channel counting entries, and nothing once deleted', async () => {
      const store = make();

      await appendAll({
        store,
        entries: [
          entryOf({ type: 'opened', cursor: 'b0', channel: 't1' }),
          entryOf({ type: 'closed', cursor: 'b40', channel: 't1' }),
          OPENED,
        ],
      });
      await appendAll({ store, conversation: second, entries: [OPENED, UPDATED] });

      const heads = async (params: { channel: string; conversation?: typeof first }) =>
        store
          .channel({ id: params.conversation ?? first, channel: params.channel })
          .head()
          .then(({ count, newest }) => [count, newest?.cursor]);

      expect(await heads({ channel: 't1' })).toEqual([2, 'b40']);
      expect(await heads({ channel: 'main' })).toEqual([1, 's0']);
      expect(await heads({ channel: 'main', conversation: second })).toEqual([2, 's1']);
      expect(await heads({ channel: 'tree' })).toEqual([0, undefined]);

      await store.delete(first);
      expect(await heads({ channel: 'main' })).toEqual([0, undefined]);
      expect(await heads({ channel: 'main', conversation: second })).toEqual([2, 's1']);
    });

    it('reads a channel nothing was written to as empty, from the start or a tail', async () => {
      const store = make();

      expect(await cursorsOf({ store })).toEqual([]);
      expect(await cursorsOf({ store, from: { tail: 3 } })).toEqual([]);
    });

    it('refuses an entry that cannot come next, and stores none of them', async () => {
      const store = make();
      const log = store.channel({ id: first, channel: 'main' });
      const refused = [
        entryOf({ type: 'updated', cursor: 's0' }),
        entryOf({ type: 'opened', cursor: 's1' }),
        entryOf({ type: 'opened', cursor: 's0', channel: 'other' }),
      ];

      for (const entry of refused) {
        await expect(log.append(entry)).rejects.toMatchObject({
          name: 'StoreError',
          reason: 'out_of_order',
        });
      }

      await log.append(OPENED);

      for (const entry of [OPENED, UPDATED_AGAIN, CLOSED]) {
        await expect(log.append(entry)).rejects.toMatchObject({ reason: 'out_of_order' });
      }

      await log.append(UPDATED);
      expect(await cursorsOf({ store })).toEqual(['s0', 's1']);
    });

    it('refuses an entry it could not read back, as invalid, and stores none of them', async () => {
      const store = make();
      const log = store.channel({ id: first, channel: 'main' });
      const unreadable = [
        past({ ...UPDATED, at: 'nope' }),
        past({ ...UPDATED, type: 'x'.repeat(200) }),
        past({ ...UPDATED, cursor: '1' }),
        // One character past the most a stored line may be, whatever the rest of it is.
        past({ ...UPDATED, pad: 'x'.repeat(MAX_CHANNEL_ENTRY_CHARS) }),
      ];

      await log.append(OPENED);

      for (const entry of unreadable) {
        await expect(log.append(entry)).rejects.toMatchObject({
          name: 'StoreError',
          reason: 'invalid',
        });
      }

      await log.append(UPDATED);
      expect(await cursorsOf({ store })).toEqual(['s0', 's1']);
    });

    it('checks and keeps an entry as its JSON, so a toJSON cannot pass at one cursor and be stored at another', async () => {
      const store = make();
      const log = store.channel({ id: first, channel: 'main' });
      // As an object this is the next entry, s1; as the line a store writes it is s7, a gap.
      const sly = past({ ...UPDATED, toJSON: () => ({ ...UPDATED, cursor: 's7' }) });

      await log.append(OPENED);
      await expect(log.append(sly)).rejects.toMatchObject({
        name: 'StoreError',
        reason: 'out_of_order',
      });

      await log.append(UPDATED);
      expect(await cursorsOf({ store })).toEqual(['s0', 's1']);
    });

    it('takes an entry of the most a stored line may be, and reads it back', async () => {
      const store = make();
      const log = store.channel({ id: first, channel: 'main' });
      const room = MAX_CHANNEL_ENTRY_CHARS - JSON.stringify({ ...OPENED, pad: '' }).length;
      const largest = past({ ...OPENED, pad: 'x'.repeat(room) });

      await log.append(largest);
      expect(await cursorsOf({ store })).toEqual(['s0']);
    });

    it('takes nothing after closed', async () => {
      const store = make();

      await appendAll({ store, entries: LIFE });
      await expect(
        store
          .channel({ id: first, channel: 'main' })
          .append(entryOf({ type: 'updated', cursor: 's4' })),
      ).rejects.toMatchObject({ reason: 'out_of_order' });
    });

    it('refuses a read after a cursor it does not hold, or of a tail that is not a count', async () => {
      const store = make();

      await appendAll({ store, entries: LIFE });

      for (const from of [
        { after: 's9' },
        { after: 'b0' },
        { after: 'main' },
        { tail: -1 },
        { tail: 1.5 },
        { tail: MAX_TAIL + 1 },
      ]) {
        await expect(cursorsOf({ store, from })).rejects.toMatchObject({
          name: 'StoreError',
          reason: 'cursor_out_of_range',
        });
      }

      // An empty channel holds no cursor, so a read after one is out of range too.
      await expect(
        cursorsOf({ store, channel: 'other', from: { after: 's0' } }),
      ).rejects.toMatchObject({
        reason: 'cursor_out_of_range',
      });
    });

    it('keeps each channel apart, by node and by conversation, and counts a byte channel in bytes', async () => {
      const store = make();

      await appendAll({
        store,
        entries: [
          entryOf({ type: 'opened', cursor: 's0', channel: 'tree' }),
          entryOf({ type: 'opened', cursor: 's0' }),
          entryOf({ type: 'opened', cursor: 'b0', channel: 't1' }),
          entryOf({ type: 'closed', cursor: 'b40', channel: 't1' }),
          entryOf({ type: 'updated', cursor: 's1', channel: 'tree' }),
        ],
      });
      await appendAll({ store, conversation: second, entries: [OPENED] });

      expect(await cursorsOf({ store, channel: 'tree' })).toEqual(['s0', 's1']);
      expect(await cursorsOf({ store })).toEqual(['s0']);
      expect(await cursorsOf({ store, channel: 't1' })).toEqual(['b0', 'b40']);
      expect(await cursorsOf({ store, conversation: second })).toEqual(['s0']);
      expect(await cursorsOf({ store, conversation: second, channel: 'tree' })).toEqual([]);
    });

    it('refuses a channel named for anything but a node id or the tree', () => {
      const store = make();

      for (const channel of ['../x', 'Main', 'a/b', '']) {
        expect(() => store.channel({ id: first, channel })).toThrow(/node id or is the tree/);
      }
    });

    it('lists the channels a conversation has stored, from their first entry, and none of another’s', async () => {
      const store = make();

      expect(await store.channels(first)).toEqual([]);

      await appendAll({
        store,
        entries: [
          entryOf({ type: 'opened', cursor: 's0', channel: 'tree' }),
          OPENED,
          entryOf({ type: 'opened', cursor: 'b0', channel: 't1' }),
          UPDATED,
        ],
      });
      await appendAll({ store, conversation: second, entries: [OPENED] });

      // A channel whose first entry was refused was never made, and a read of one does not make it.
      await expect(
        store.channel({ id: first, channel: 'never' }).append(UPDATED),
      ).rejects.toMatchObject({ reason: 'out_of_order' });
      expect(await cursorsOf({ store, channel: 'unread' })).toEqual([]);

      expect((await store.channels(first)).toSorted()).toEqual(['main', 't1', 'tree']);
      expect(await store.channels(second)).toEqual(['main']);

      await store.delete(first);
      expect(await store.channels(first)).toEqual([]);
      expect(await store.channels(second)).toEqual(['main']);
    });

    it('deletes a conversation’s channels with it, and none of another, and starts again from opened', async () => {
      const store = make();

      await appendAll({ store, entries: LIFE });
      await appendAll({ store, conversation: second, entries: LIFE });
      await store.delete(first);

      expect(await cursorsOf({ store })).toEqual([]);
      expect(await cursorsOf({ store, conversation: second })).toEqual(['s0', 's1', 's2', 's3']);

      const log = store.channel({ id: first, channel: 'main' });

      await expect(log.append(UPDATED)).rejects.toMatchObject({
        reason: 'out_of_order',
      });
      await log.append(OPENED);
      expect(await cursorsOf({ store })).toEqual(['s0']);
    });
  });
}

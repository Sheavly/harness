import { describe, expect, it } from 'vitest';
import type {
  ChannelEntry,
  ChannelFrom,
  ChannelLimits,
  ConversationStore,
} from '@sheavly/core/store/store.types';
import { MAX_CHANNEL_ENTRY_CHARS } from '@sheavly/protocol/channel/channel.constants';
import { conversationIdSchema } from '@sheavly/protocol/server/server.validator';
import { MAX_TAIL } from '@sheavly/protocol/subscription/subscription.constants';

/** An entry wrong in a way its type does not allow, as a caller can still send one at run time. */
const past = (entry: Record<string, unknown>): never => entry as never;

const first = conversationIdSchema.parse('00000000-0000-4000-8000-0000000000a1');
const second = conversationIdSchema.parse('00000000-0000-4000-8000-0000000000a2');

/**
 * Test-only: an entry of `channel` (a node id, or `tree`; `main` by default) with this type and
 * cursor, holding the node it is about as a channel's entries do.
 */
const entryOf = (params: { type: string; cursor: string; channel?: string }): ChannelEntry => ({
  channel: params.channel ?? 'main',
  type: params.type,
  cursor: params.cursor,
  at: 0,
  node: { id: params.channel ?? 'main', title: 'Chat' },
});

/** What an entry costs in a limit: its line, as a store keeps it. */
const lineBytes = (entry: ChannelEntry) => Buffer.byteLength(JSON.stringify(entry)) + 1;

/** The cursors `channel` of `conversation` reads back from `from`. */
async function cursorsOf(params: {
  store: ConversationStore;
  channel?: string;
  conversation?: typeof first;
  from?: ChannelFrom | undefined;
}) {
  const { store, channel = 'main', conversation = first, from } = params;
  const cursors: string[] = [];

  for await (const each of store.channel({ id: conversation, channel }).read(from)) {
    cursors.push(each.cursor);
  }

  return cursors;
}

/** Appends `entries` one after another, each to the channel it names. */
async function appendAll(params: {
  store: ConversationStore;
  entries: ChannelEntry[];
  conversation?: typeof first;
}) {
  const { store, entries, conversation = first } = params;

  for (const each of entries) {
    await store.channel({ id: conversation, channel: each.channel }).append(each);
  }
}

const OPENED = entryOf({ type: 'opened', cursor: 's0' });
const UPDATED = entryOf({ type: 'updated', cursor: 's1' });
const UPDATED_AGAIN = entryOf({ type: 'updated', cursor: 's2' });
const CLOSED = entryOf({ type: 'closed', cursor: 's3' });
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

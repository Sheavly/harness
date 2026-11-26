import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import type {
  ChannelEntry,
  ChannelFrom,
  ChannelLog,
  ConversationStore,
} from '@sheavly/core/store/store.types';
import { FileConversationStore } from '@sheavly/storage/conversation-store/conversation-store.service';
import { readChannel } from '@sheavly/runtime/testing/stored-channels.fake';
import { useTempFolders } from '@sheavly/testing/files/temp-folders.fake';
import { useOpenedServers } from '../../testing/opened-servers.fake.js';
import { servedConversation } from '../../testing/served-conversation.fake.js';
import { framesOf } from '../../testing/subscription-frames.fake.js';

// A channel that holds weeks of a conversation, read over HTTP from a real file store: what a client
// that reconnects with the cursor it last saw, or asks for a tail, makes the store read. Every entry
// the store hands out for the long channel is counted, so a host that read the channel whole would
// show. How the file store finds its place without reading the lines before it is shown in its own
// tests (a damaged line before a tail is never read).

const servers = useOpenedServers();
const folders = useTempFolders({ prefix: 'stream-channels-long-', names: [] });

/** The long channel's node, and how many entries it holds: `opened`, 2,998 `updated`, `closed`. */
const LONG = 'weeks-old-agent';
const COUNT = 3_000;

/** A file store that says how many entries it handed out of each channel, in all, as it is read. */
class CountingStore extends FileConversationStore {
  readonly handedOut = new Map<string, number>();

  override channel(params: Parameters<FileConversationStore['channel']>[0]): ChannelLog {
    const log = super.channel(params);

    return {
      append: async (entry) => log.append(entry),
      head: async () => log.head(),
      read: (from) => this.#counted({ channel: params.channel, entries: log.read(from) }),
    };
  }

  async *#counted(params: { channel: string; entries: AsyncIterable<ChannelEntry> }) {
    for await (const entry of params.entries) {
      this.handedOut.set(params.channel, (this.handedOut.get(params.channel) ?? 0) + 1);
      yield entry;
    }
  }
}

const storeOf = () =>
  new CountingStore({ folder: path.join(folders.base, 'kept'), onProblem: () => undefined });

/** A conversation that ran one prompt, over a real file store with a channel of `COUNT` entries. */
async function served() {
  const store = storeOf();
  const world = await servedConversation({ servers, store });
  const main = (await store.channels(world.conversation)).find((name) => name !== 'tree') ?? '';
  const [opened] = await readChannel({ store, id: world.conversation, channel: main });

  if (!opened) throw new Error('the main agent has no channel');

  // The node as the main agent's channel opened it, under another id: a channel no writer has, as
  // one a stopped server left, which is read from the store.
  const node = { ...(opened.node as object), id: LONG };
  const log = store.channel({ id: world.conversation, channel: LONG });
  const at = opened.at;

  await log.append({ channel: LONG, type: 'opened', cursor: 's0', at, node });

  for (let place = 1; place < COUNT - 1; place += 1) {
    await log.append({ channel: LONG, type: 'updated', cursor: `s${String(place)}`, at, node });
  }

  await log.append({
    channel: LONG,
    type: 'closed',
    cursor: `s${String(COUNT - 1)}`,
    at,
    state: 'completed',
    outcome: 'completed',
  });
  store.handedOut.clear();

  return { ...world, store };
}

/** What a subscription to the long channel from `from` sends: the cursors of its entries, and how it ended. */
async function readFrom(params: { world: Awaited<ReturnType<typeof served>>; from: string }) {
  const { client, id } = params.world;
  const next = framesOf(
    await client.open('streamChannels', {
      id,
      body: { subscriptions: [{ channel: LONG, from: params.from }] },
    }),
  );
  const cursors: string[] = [];

  for (let got = await next(); got; got = await next()) {
    if (got.frame.type === 'end') return { cursors, ended: got.frame.reason };

    if (got.event === 'entry') cursors.push(got.frame.cursor);
  }

  return { cursors, ended: undefined };
}

const range = (from: number, to: number) =>
  Array.from({ length: to - from }, (_, n) => `s${String(from + n)}`);

describe('a channel of weeks, read over HTTP from a real file store', () => {
  it('sends the last entries of a tail, and the store hands out only those', async () => {
    const world = await served();

    expect(await readFrom({ world, from: 'tail:3' })).toEqual({
      cursors: range(COUNT - 3, COUNT),
      ended: 'completed',
    });
    expect(world.store.handedOut.get(LONG)).toBe(3);
  });

  it('sends what follows the cursor a client kept, and the store hands out only that', async () => {
    const world = await served();

    expect(await readFrom({ world, from: 's2990' })).toEqual({
      cursors: range(2991, COUNT),
      ended: 'completed',
    });
    expect(world.store.handedOut.get(LONG)).toBe(COUNT - 2991);

    world.store.handedOut.clear();
    // The newest cursor it has: nothing more to send, and nothing read.
    expect(await readFrom({ world, from: `s${String(COUNT - 1)}` })).toEqual({
      cursors: [],
      ended: 'completed',
    });
    expect(world.store.handedOut.get(LONG)).toBeUndefined();
  });

  it('sends all of it from the start, which is what asking for it costs', async () => {
    const world = await served();
    const sent = await readFrom({ world, from: 'start' });

    expect(sent.cursors).toEqual(range(0, COUNT));
    expect(sent.ended).toBe('completed');
    expect(world.store.handedOut.get(LONG)).toBe(COUNT);
  });

  it('is covered by an index on disk, and a store started again over the folder holds it as it was', async () => {
    const world = await served();
    const folder = path.join(folders.base, 'kept', 'conversations', world.conversation, 'channels');
    const index = JSON.parse(await readFile(path.join(folder, `${LONG}.idx`), 'utf8')) as {
      count: number;
      offsets: unknown[];
    };

    // The channel ended, so the index covers all of it: one offset for each block of 1,024 lines.
    expect(index).toMatchObject({ count: COUNT });
    expect(index.offsets).toHaveLength(Math.ceil(COUNT / 1_024));

    const restarted: ConversationStore = storeOf();
    const read = async (from: ChannelFrom) => {
      const cursors: string[] = [];

      for await (const entry of restarted
        .channel({ id: world.conversation, channel: LONG })
        .read(from)) {
        cursors.push(entry.cursor);
      }

      return cursors;
    };

    expect(await restarted.channel({ id: world.conversation, channel: LONG }).head()).toMatchObject(
      { count: COUNT, newest: { cursor: `s${String(COUNT - 1)}`, type: 'closed' } },
    );
    expect(await read({ tail: 2 })).toEqual(range(COUNT - 2, COUNT));
  });
});

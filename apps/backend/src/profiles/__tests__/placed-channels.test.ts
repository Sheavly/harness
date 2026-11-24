import path from 'node:path';
import { describe, expect, it } from 'vitest';
import type { ChannelEntry } from '@sheavly/core/store/store.types';
import { profileIdSchema } from '@sheavly/protocol/profile/profile.validator';
import { conversationIdSchema } from '@sheavly/protocol/server/server.validator';
import { FileConversationStore } from '@sheavly/storage/conversation-store/conversation-store.service';
import { useTempFolders } from '@sheavly/testing/files/temp-folders.fake';
import { PlacedConversationStore } from '../placed-conversation-store.service.js';
import { Profiles } from '../profiles.service.js';
import type { Placement } from '../profiles.types.js';

const folders = useTempFolders({ prefix: 'placed-channels-', names: ['app'] });
const ID = conversationIdSchema.parse('00000000-0000-4000-8000-0000000000cc');
const PROFILE = profileIdSchema.parse('9d2c7e10-6a4b-4f38-b1e5-5c0a8d3f2b99');

const opened: ChannelEntry = { channel: 'main', type: 'opened', cursor: 's0', at: 1, node: {} };
const updated: ChannelEntry = { channel: 'main', type: 'updated', cursor: 's1', at: 2, node: {} };

/** One profile with one folder, whose conversations are kept in `store`: nothing else to find. */
class OneFolder extends Profiles {
  readonly #placement: Placement;
  readonly #store: FileConversationStore;

  constructor(params: { home: string; store: FileConversationStore }) {
    super({ env: { SHEAVLY_HOME: params.home } });
    this.#placement = { workspace: path.join(params.home, 'work'), profile: PROFILE };
    this.#store = params.store;
  }

  override async place(): Promise<Placement> {
    return this.#placement;
  }

  override async conversationsFor(): Promise<FileConversationStore> {
    return this.#store;
  }

  override async everyStore() {
    return [{ placement: this.#placement, store: this.#store }];
  }
}

function placedOver(store: FileConversationStore) {
  return new PlacedConversationStore({
    profiles: new OneFolder({ home: path.join(folders.base, 'home'), store }),
    fallbackWorkspace: folders.app,
    onProblem: () => undefined,
  });
}

const kept = () =>
  new FileConversationStore({
    folder: path.join(folders.base, 'kept'),
    onProblem: () => undefined,
  });

async function cursorsOf(store: PlacedConversationStore) {
  const cursors: string[] = [];

  for await (const each of store.channel({ id: ID, channel: 'main' }).read()) {
    cursors.push(each.cursor);
  }

  return cursors;
}

describe('a conversation’s channels through the placed store', () => {
  it('are written where the conversation was placed, and read back from there', async () => {
    const files = kept();
    const placed = placedOver(files);

    await placed.decide({ id: ID, asked: {} });
    await placed.channel({ id: ID, channel: 'main' }).append(opened);
    await placed.channel({ id: ID, channel: 'main' }).append(updated);

    expect(await cursorsOf(placed)).toEqual(['s0', 's1']);

    // The store that keeps the conversation holds them: the wrapper only found the place.
    const cursors: string[] = [];

    for await (const each of files.channel({ id: ID, channel: 'main' }).read({ tail: 1 })) {
      cursors.push(each.cursor);
    }

    expect(cursors).toEqual(['s1']);
  });

  it('are listed from where the conversation is kept, and none for one nobody kept', async () => {
    const placed = placedOver(kept());

    expect(await placed.channels(ID)).toEqual([]);

    await placed.decide({ id: ID, asked: {} });
    await placed.channel({ id: ID, channel: 'main' }).append(opened);
    expect(await placed.channels(ID)).toEqual(['main']);
  });

  it('refuse a name that is not a node id or the tree at once, placed or not', async () => {
    const placed = placedOver(kept());

    for (const channel of ['../escape', 'Main', 'a/b']) {
      expect(() => placed.channel({ id: ID, channel })).toThrow(/node id or is the tree/);
    }

    await placed.decide({ id: ID, asked: {} });
    expect(() => placed.channel({ id: ID, channel: '../escape' })).toThrow(
      /node id or is the tree/,
    );
  });

  it('read as nothing for a conversation nobody placed or kept, and refuse a write to it', async () => {
    const placed = placedOver(kept());

    expect(await cursorsOf(placed)).toEqual([]);
    await expect(placed.channel({ id: ID, channel: 'main' }).append(opened)).rejects.toMatchObject({
      name: 'StoreError',
      reason: 'failed',
    });
  });
});

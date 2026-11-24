import { describe, expect, it } from 'vitest';
import { StoreError } from '@sheavly/core/errors/store.errors';
import { MemoryConversationStore } from '../memory-store.fake.js';
import { describeChannelLog } from '../channel-contract.fake.js';
import { describeChannelLimits } from '../channel-limits-contract.fake.js';
import {
  CONVERSATION as id,
  READER as session,
  describeConversationStore,
  entry,
  indexOf,
} from '../store-contract.fake.js';

describeConversationStore({
  name: 'MemoryConversationStore',
  make: () => new MemoryConversationStore(),
});

describeChannelLog({ name: 'MemoryConversationStore', make: () => new MemoryConversationStore() });
describeChannelLimits({
  name: 'MemoryConversationStore',
  make: (limits) => new MemoryConversationStore({ limits }),
});

describe('MemoryConversationStore', () => {
  it('hands out copies of a channel’s entries, and fails its writes while told to', async () => {
    const store = new MemoryConversationStore();
    const log = store.channel({ id, channel: 'main' });
    const opened = { channel: 'main', cursor: 's0', type: 'opened', at: 0, node: { id: 'main' } };

    await log.append(opened);

    for await (const each of log.read()) each.node = 'changed';

    for await (const each of log.read()) expect(each).toEqual(opened);

    store.failWith(new Error('ENOSPC'));
    await expect(log.append({ ...opened, type: 'updated', cursor: 's1' })).rejects.toMatchObject({
      reason: 'failed',
    });
  });

  it('hands out copies of its entries, so a reader cannot change what is stored', async () => {
    const store = new MemoryConversationStore();

    await store.entries(id).append(entry(0));

    for await (const each of store.entries(id).read()) {
      if (each.kind === 'event' && each.event.type === 'text_delta') each.event.text = 'changed';
    }

    for await (const each of store.entries(id).read()) {
      expect(each).toEqual(entry(0));
    }
  });

  it('fails every write while told to, as a full disk does, then mends', async () => {
    const store = new MemoryConversationStore();
    const disk = new Error('ENOSPC');

    store.failWith(disk);

    for (const write of [
      () => store.entries(id).append(entry(0)),
      () => store.writeIndex(indexOf(id, 1)),
      () =>
        store.history({ id, session }).append([{ seq: 0, entry: { role: 'user', content: 'hi' } }]),
      () => store.delete(id),
    ]) {
      await expect(write()).rejects.toBeInstanceOf(StoreError);
      await expect(write()).rejects.toMatchObject({ reason: 'failed', cause: disk });
    }

    store.failWith(undefined);
    await store.entries(id).append(entry(0));

    const seqs: number[] = [];

    for await (const each of store.entries(id).read()) seqs.push(each.seq);
    expect(seqs).toHaveLength(1);
  });
});

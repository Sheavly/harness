import { readdir } from 'node:fs/promises';
import path from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ChannelEntry, ChannelLimits } from '@sheavly/core/store/store.types';
import { conversationIdSchema } from '@sheavly/protocol/server/server.validator';
import type * as JsonlFile from '../../jsonl-file/jsonl-file.helper.js';
import { useTempFolder } from '../../testing/temp-folder.fake.js';
import { FileConversationStore } from '../conversation-store.service.js';

/** How many of the next appends to a channel's file fail, as a disk that is full or failing does. */
const failures = vi.hoisted(() => ({ left: 0 }));

// Only the append fails. Reading, trimming and counting the file work, so a failed write is the
// one thing that reaches the quota, as it does on a disk that fails halfway.
vi.mock('../../jsonl-file/jsonl-file.helper.js', async (importOriginal) => {
  const actual = await importOriginal<typeof JsonlFile>();

  return {
    ...actual,
    appendJsonLine: async (params: Parameters<typeof actual.appendJsonLine>[0]) => {
      if (failures.left > 0) {
        failures.left -= 1;
        throw new Error('ENOSPC');
      }

      return actual.appendJsonLine(params);
    },
  };
});

const temp = useTempFolder('file-channel-failures-');
const id = conversationIdSchema.parse('00000000-0000-4000-8000-0000000000c1');

const entry = (type: string, cursor: string, channel: string): ChannelEntry => ({
  channel,
  type,
  cursor,
  at: 1,
  node: { id: channel, title: 'Chat' },
});

const line = (appended: ChannelEntry) => Buffer.byteLength(JSON.stringify(appended)) + 1;
const storeOf = (limits: Partial<ChannelLimits>) =>
  new FileConversationStore({ folder: temp.path(), onProblem: () => undefined, limits });
const channelsFolder = () => path.join(temp.path(), 'conversations', id, 'channels');

async function cursorsOf(store: FileConversationStore, channel: string) {
  const cursors: string[] = [];

  for await (const each of store.channel({ id, channel }).read()) cursors.push(each.cursor);

  return cursors;
}

describe('a channel whose writes fail', () => {
  // A test that fails midway must not leave failures for the next.
  beforeEach(() => {
    failures.left = 0;
  });

  it('with entries, does not fill its room with writes that failed, nor close itself for good', async () => {
    const opened = entry('opened', 's0', 'main');
    const updated = entry('updated', 's1', 'main');
    // Room for the first entry and three more: thirty failures would pass it, if each kept what it
    // reserved, and the channel would then refuse everything and leave a marker.
    const store = storeOf({ channelBytes: line(opened) + line(updated) * 3 });
    const log = store.channel({ id, channel: 'main' });

    await log.append(opened);
    failures.left = 30;

    for (let attempt = 0; attempt < 30; attempt += 1) {
      await expect(log.append(updated)).rejects.toMatchObject({
        name: 'StoreError',
        reason: 'failed',
      });
    }

    // The disk has mended.
    await log.append(updated);
    expect(await cursorsOf(store, 'main')).toEqual(['s0', 's1']);
    expect(await readdir(channelsFolder())).toEqual(['main.jsonl']);
  });

  it('can be written again after its first write failed, when its room is one line', async () => {
    const opened = entry('opened', 's0', 'main');
    // A channel with no entries does not count the files again before it refuses, so what a failed
    // write held must be given back by the channel itself when it reads its file again.
    const store = storeOf({ channelBytes: line(opened) + 10 });
    const log = store.channel({ id, channel: 'main' });

    failures.left = 1;
    await expect(log.append(opened)).rejects.toMatchObject({ reason: 'failed' });

    await log.append(opened);
    expect(await cursorsOf(store, 'main')).toEqual(['s0']);
  });

  it('does not refuse another channel for good for room a failed write still held', async () => {
    const mainOpened = entry('opened', 's0', 'main');
    const mainUpdated = entry('updated', 's1', 'main');
    const t1Opened = entry('opened', 's0', 't1');
    const t1Updated = entry('updated', 's1', 't1');
    // Room for what is on disk and one more line of t1, and no more.
    const store = storeOf({
      conversationBytes: line(mainOpened) + line(t1Opened) + line(t1Updated) + 10,
    });

    await store.channel({ id, channel: 'main' }).append(mainOpened);
    await store.channel({ id, channel: 't1' }).append(t1Opened);

    // A write of main fails and holds its room; main does not write again.
    failures.left = 1;
    await expect(store.channel({ id, channel: 'main' }).append(mainUpdated)).rejects.toMatchObject({
      reason: 'failed',
    });

    // t1's line fits what is on disk. A refusal for good, with a marker that outlives a restart,
    // would be made on the room that main's failed write still holds, so t1 counts the files first.
    await store.channel({ id, channel: 't1' }).append(t1Updated);
    expect(await cursorsOf(store, 't1')).toEqual(['s0', 's1']);
    expect((await readdir(channelsFolder())).toSorted()).toEqual(['main.jsonl', 't1.jsonl']);
  });
});

import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import type { ChannelEntry, ChannelFrom } from '@sheavly/core/store/store.types';
import { useTempFolder } from '../../testing/temp-folder.fake.js';
import { ChannelFile } from '../channel-file.service.js';
import { ChannelQuota } from '../channel-quota.service.js';
import { DEFAULT_CHANNEL_LIMITS } from '../conversation-store.constants.js';

const temp = useTempFolder('channel-seek-');

/** Entries per block: small, so a log of a few dozen lines has several and every edge is near. */
const EVERY = 4;
/** Lines the tests' channels hold: six whole blocks and a part of a seventh. */
const COUNT = EVERY * 6 + 3;

const entry = (cursor: string, channel = 'main'): ChannelEntry => ({
  channel,
  type: cursor === 's0' || cursor === 'b0' ? 'opened' : 'updated',
  cursor,
  at: 1,
  node: { id: channel, title: 'Chat' },
});

const sequence = (count: number) => Array.from({ length: count }, (_, n) => entry(`s${String(n)}`));
const cursorsOf = (entries: ChannelEntry[]) => entries.map((each) => each.cursor);
const range = (from: number, to: number) =>
  Array.from({ length: Math.max(0, to - from) }, (_, n) => `s${String(from + n)}`);

/** A channel file over the test's folder: a new one each call, as a restarted process would be. */
function fileOf(channel = 'main') {
  const folder = path.join(temp.path(), 'channels');

  return {
    path: path.join(folder, `${channel}.jsonl`),
    log: new ChannelFile({
      file: path.join(folder, `${channel}.jsonl`),
      markerFile: path.join(folder, `${channel}.full`),
      channel,
      quota: new ChannelQuota({ folder, limits: DEFAULT_CHANNEL_LIMITS }),
      indexEvery: EVERY,
    }),
  };
}

async function read(log: ChannelFile, from?: ChannelFrom) {
  const entries: ChannelEntry[] = [];

  for await (const each of log.read(from)) entries.push(each);

  return cursorsOf(entries);
}

/** A channel of `count` entries, appended by the process that then reads it (`live`) or by one before. */
async function channelOf(params: { count: number; live: boolean }) {
  const writer = fileOf();

  for (const each of sequence(params.count)) await writer.log.append(each);

  return params.live ? writer : fileOf();
}

describe.each([
  ['in the process that wrote it', true],
  ['after a restart', false],
])('a channel file, read %s', (_name, live) => {
  it('gives what is after any cursor it holds, whichever block it is in', async () => {
    const { log } = await channelOf({ count: COUNT, live });

    for (let position = 0; position < COUNT; position += 1) {
      expect(await read(log, { after: `s${String(position)}` })).toEqual(
        range(position + 1, COUNT),
      );
    }
  });

  it('gives the last entries for any tail, a tail past the whole of it the whole of it', async () => {
    const { log } = await channelOf({ count: COUNT, live });

    for (let tail = 0; tail <= COUNT + 3; tail += 1) {
      expect(await read(log, { tail })).toEqual(range(Math.max(0, COUNT - tail), COUNT));
    }
  });

  it('says how many entries it holds and the newest, and a refused cursor is out of range', async () => {
    const { log } = await channelOf({ count: COUNT, live });

    expect(await log.head()).toEqual({
      count: COUNT,
      newest: { channel: 'main', cursor: `s${String(COUNT - 1)}`, type: 'updated' },
    });

    for (const after of [`s${String(COUNT)}`, 's999', 'b0', 'main']) {
      await expect(read(log, { after })).rejects.toMatchObject({
        name: 'StoreError',
        reason: 'cursor_out_of_range',
      });
    }
  });
});

describe('a channel file, as it is written to', () => {
  it('keeps what it holds and the places to read from in step with each append', async () => {
    const { log } = fileOf();

    expect(await log.head()).toEqual({ count: 0, newest: undefined });

    for (const [index, each] of sequence(COUNT).entries()) {
      await log.append(each);
      expect((await log.head()).count).toBe(index + 1);

      // Each entry is found by its own cursor, as the last one is, with the index grown as it goes.
      expect(await read(log, { after: each.cursor })).toEqual([]);
      expect(await read(log, { tail: 1 })).toEqual([each.cursor]);
    }

    expect(await read(log, { after: 's2' })).toEqual(range(3, COUNT));
  });

  it('gives a read what it held when the read began, and the next read what was added', async () => {
    const { log } = await channelOf({ count: COUNT, live: true });
    const reading = log.read({ tail: 3 })[Symbol.asyncIterator]();
    const seen: string[] = [];
    const take = async () => {
      const next = await reading.next();

      if (!next.done) seen.push(next.value.cursor);

      return next.done;
    };

    await take();
    await log.append(entry(`s${String(COUNT)}`));

    while (!(await take())) {
      // Each entry the read gives is taken as it comes.
    }

    expect(seen).toEqual(range(COUNT - 3, COUNT));
    expect(await read(log, { tail: 3 })).toEqual(range(COUNT - 2, COUNT + 1));
    expect((await log.head()).count).toBe(COUNT + 1);
  });

  it('reads no more of the file than it gives: a damaged line before a cursor or a tail is not read', async () => {
    const { log, path: file } = await channelOf({ count: COUNT, live: true });
    const lines = (await readFile(file, 'utf8')).split('\n');
    const damaged = 9;

    // The line is no longer JSON, and as long as it was, so no place after it moves.
    lines[damaged] = `X${(lines[damaged] ?? '').slice(1)}`;
    await writeFile(file, lines.join('\n'));

    expect(await read(log, { tail: 3 })).toEqual(range(COUNT - 3, COUNT));
    expect(await read(log, { after: 's14' })).toEqual(range(15, COUNT));
    // What reaches the damaged line, from the start or from before it, is refused.
    await expect(read(log)).rejects.toMatchObject({ name: 'StoreError' });
    await expect(read(log, { after: 's2' })).rejects.toMatchObject({ name: 'StoreError' });
  });

  it('counts a byte channel by its entries, and finds a cursor in it by reading', async () => {
    const { log } = fileOf('t1');

    for (const cursor of ['b0', 'b40', 'b95']) await log.append(entry(cursor, 't1'));

    expect(await log.head()).toMatchObject({ count: 3, newest: { cursor: 'b95' } });
    expect(await read(log, { after: 'b0' })).toEqual(['b40', 'b95']);
    expect(await read(log, { tail: 2 })).toEqual(['b40', 'b95']);
    await expect(read(log, { after: 's0' })).rejects.toMatchObject({
      reason: 'cursor_out_of_range',
    });
  });

  it('holds nothing of a channel nothing was written to, and makes no file by being asked', async () => {
    const { log, path: file } = fileOf();

    expect(await log.head()).toEqual({ count: 0, newest: undefined });
    expect(await read(log, { tail: 3 })).toEqual([]);
    expect(await read(log)).toEqual([]);
    await expect(read(log, { after: 's0' })).rejects.toMatchObject({
      reason: 'cursor_out_of_range',
    });
    await expect(readFile(file)).rejects.toMatchObject({ code: 'ENOENT' });
  });
});

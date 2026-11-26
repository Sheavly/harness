import { readFile, writeFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import {
  channelFileIn,
  cursorsFrom,
  entry,
  range,
  sequence,
} from '../../testing/channel-file.fake.js';
import { useTempFolder } from '../../testing/temp-folder.fake.js';
import { linesFrom } from '../channel-seek.helper.js';

const temp = useTempFolder('channel-seek-');

/** Entries per block: small, so a log of a few dozen lines has several and every edge is near. */
const EVERY = 4;
/** Lines the tests' channels hold: six whole blocks and a part of a seventh. */
const COUNT = EVERY * 6 + 3;

/** A channel file over the test's folder: a new one each call, as a restarted process would be. */
const fileOf = (channel = 'main') => channelFileIn({ folder: temp.path(), every: EVERY, channel });
const read = cursorsFrom;

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

  it('gives the next read what was added, and head the new count', async () => {
    const { log } = await channelOf({ count: COUNT, live: true });

    await log.append(entry(`s${String(COUNT)}`));

    expect(await read(log, { tail: 3 })).toEqual(range(COUNT - 2, COUNT + 1));
    expect((await log.head()).count).toBe(COUNT + 1);
  });

  it('goes no further than the lines it was told the file held, though the file has more', async () => {
    const { path: file } = await channelOf({ count: COUNT, live: true });
    const index = JSON.parse(await readFile(fileOf().indexPath, 'utf8')) as { offsets: number[] };

    // The file holds 27 lines; a read that began when it held 25 is for those: the two that came
    // after are the next read's, and the writer tells them.
    const seen = { count: COUNT - 2, offsets: index.offsets, kind: 'sequence' } as const;
    const lines = linesFrom({ file, seen, every: EVERY, index: COUNT - 5 });
    const cursors: string[] = [];

    for await (const each of lines) cursors.push(each.cursor);

    expect(cursors).toEqual(range(COUNT - 5, COUNT - 2));
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

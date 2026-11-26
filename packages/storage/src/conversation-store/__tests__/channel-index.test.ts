import { createReadStream } from 'node:fs';
import type * as FsModule from 'node:fs';
import { appendFile, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import {
  channelFileIn,
  cursorsFrom,
  entry,
  range,
  sequence,
} from '../../testing/channel-file.fake.js';
import { StoreError } from '@sheavly/core/errors/store.errors';
import { StorageFileError } from '../../errors/storage.errors.js';
import { useTempFolder } from '../../testing/temp-folder.fake.js';
import { isLogDamage } from '../channel-index.helper.js';
import { MAX_CHANNEL_INDEX_BYTES } from '../conversation-store.constants.js';

// The same function, which a test can count the calls of: how often a log is read from its first byte.
vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof FsModule>();

  return { ...actual, createReadStream: vi.fn(actual.createReadStream) };
});

const temp = useTempFolder('channel-index-');

/** Lines in a block of the index: small, so a few lines have several. */
const EVERY = 4;

/** How many times `main`'s log was read whole, from its first byte, since the count was cleared. */
const wholeReads = () =>
  vi
    .mocked(createReadStream)
    .mock.calls.filter(
      ([place, options]) =>
        String(place).endsWith('main.jsonl') && !(typeof options === 'object' && options.start),
    ).length;

const fileOf = (channel = 'main') => channelFileIn({ folder: temp.path(), every: EVERY, channel });

/** A channel of `count` lines, written by a process that has since ended. */
async function written(count: number) {
  const writer = fileOf();

  for (const each of sequence(count)) await writer.log.append(each);

  return writer;
}

const indexOf = async () =>
  JSON.parse(await readFile(fileOf().indexPath, 'utf8')) as Record<string, unknown>;

/** Replaces `text` with `by` in the file at `place`, which holds JSON the store wrote. */
async function edit(params: { place: string; text: string; by: string }) {
  const content = await readFile(params.place, 'utf8');

  expect(content).toContain(params.text);
  await writeFile(params.place, content.replace(params.text, params.by));
}

describe('what is the log’s damage', () => {
  const file = '/somewhere/main.jsonl';

  it('is a line that is not well formed, and not a read of the disk that failed', () => {
    // What the line reader and the scan make of a line that is not JSON, or not a channel's entry.
    expect(isLogDamage(new StorageFileError({ file, cause: undefined, reason: 'line 6' }))).toBe(
      true,
    );
    expect(isLogDamage(new StoreError({ reason: 'failed', message: 'not well formed' }))).toBe(
      true,
    );
    // The disk, which may read next time, and anything that is not an error of the log.
    expect(isLogDamage(new StorageFileError({ file, cause: new Error('EIO') }))).toBe(false);
    expect(isLogDamage(new Error('something else'))).toBe(false);
    expect(isLogDamage('not even an error')).toBe(false);
  });
});

describe('what a channel keeps beside its log', () => {
  it('is written at the end of a block, and not before there is one', async () => {
    const { log, indexPath } = fileOf();

    for (const each of sequence(EVERY - 1)) await log.append(each);

    await expect(readFile(indexPath)).rejects.toMatchObject({ code: 'ENOENT' });

    for (const each of sequence(2 * EVERY + 1).slice(EVERY - 1)) await log.append(each);

    // Two whole blocks are covered; the ninth line is not, until its block ends.
    expect(await indexOf()).toMatchObject({ every: EVERY, count: 2 * EVERY });
    expect((await indexOf()).offsets).toHaveLength(2);
  });

  it('covers a channel that ended whole, whatever its length', async () => {
    const { log } = fileOf();

    for (const each of sequence(EVERY + 2)) await log.append(each);

    await log.append({ ...entry(`s${String(EVERY + 2)}`), type: 'closed' });

    expect(await indexOf()).toMatchObject({ count: EVERY + 3, last: { type: 'closed' } });
  });

  it('is what a process that starts reads, so it trusts the lines the index covers and reads those after', async () => {
    await written(2 * EVERY + 2);

    // A line the index covers is damaged without changing its length: only a read that reaches
    // it finds out, and what comes after the index is read and checked as before.
    const { path: log } = fileOf();

    await edit({ place: log, text: '"cursor":"s2"', by: '"cursor":"X2"' });

    const restarted = fileOf().log;

    expect(await restarted.head()).toMatchObject({ count: 2 * EVERY + 2 });
    expect(await cursorsFrom(restarted, { tail: 3 })).toEqual(range(2 * EVERY - 1, 2 * EVERY + 2));
    await expect(cursorsFrom(restarted)).rejects.toMatchObject({ name: 'StoreError' });
  });

  it('is not trusted when the log is not as it left it: the line it ends with is not the one it had', async () => {
    await written(2 * EVERY + 2);

    // The index ends with line s7. A line there that says it is another's (as long as it was) is a
    // log the index was not made for, which only reading it all shows is out of order.
    await edit({
      place: fileOf().path,
      text: `"cursor":"s${String(2 * EVERY - 1)}"`,
      by: '"cursor":"s6"',
    });

    await expect(fileOf().log.head()).rejects.toMatchObject({
      name: 'StoreError',
      message: expect.stringContaining('not well formed') as string,
    });
  });

  it('is not trusted past what it covers: a line after it that is not well formed is refused', async () => {
    await written(2 * EVERY + 2);

    await edit({
      place: fileOf().path,
      text: `"cursor":"s${String(2 * EVERY + 1)}"`,
      by: '"cursor":"s99"',
    });

    await expect(fileOf().log.head()).rejects.toMatchObject({
      name: 'StoreError',
      message: expect.stringContaining('not well formed') as string,
    });
  });

  it('carries on from the lines after it: what is appended after a restart is found and read', async () => {
    await written(2 * EVERY + 2);

    const restarted = fileOf().log;

    await restarted.append(entry(`s${String(2 * EVERY + 2)}`));

    expect(await restarted.head()).toMatchObject({ count: 2 * EVERY + 3 });
    expect(await cursorsFrom(restarted, { after: `s${String(EVERY)}` })).toEqual(
      range(EVERY + 1, 2 * EVERY + 3),
    );
    expect(await cursorsFrom(fileOf().log, { tail: 2 })).toEqual(
      range(2 * EVERY + 1, 2 * EVERY + 3),
    );
  });

  it.each([
    ['not an index', async () => writeFile(fileOf().indexPath, 'not json')],
    [
      'one for blocks of another size',
      async () =>
        edit({ place: fileOf().indexPath, text: `"every": ${String(EVERY)}`, by: '"every": 8' }),
    ],
    [
      'one that covers more than the log holds',
      async () => edit({ place: fileOf().indexPath, text: '"size": ', by: '"size": 1' }),
    ],
    [
      'one whose last line is not the log’s',
      async () =>
        edit({ place: fileOf().indexPath, text: '"lastOffset": ', by: '"lastOffset": 1' }),
    ],
    [
      'one that says another line was last',
      async () => edit({ place: fileOf().indexPath, text: '"cursor": "s7"', by: '"cursor": "s5"' }),
    ],
    [
      'one too big to read',
      async () => writeFile(fileOf().indexPath, 'x'.repeat(MAX_CHANNEL_INDEX_BYTES + 1)),
    ],
  ])(
    'is ignored when it is %s: the log is read, and the index made again',
    async (_name, spoil) => {
      await written(2 * EVERY + 2);
      await spoil();

      const restarted = fileOf().log;

      expect(await restarted.head()).toMatchObject({
        count: 2 * EVERY + 2,
        newest: { cursor: `s${String(2 * EVERY + 1)}` },
      });
      expect(await cursorsFrom(restarted, { after: 's2' })).toEqual(range(3, 2 * EVERY + 2));
      expect(await indexOf()).toMatchObject({ every: EVERY, count: 2 * EVERY + 2 });
    },
  );

  /** Where line `place` of the log starts, in bytes: the lines before it, each with its newline. */
  async function offsetOfLine(params: { log: string; place: number }) {
    const lines = (await readFile(params.log, 'utf8')).split('\n').slice(0, params.place);

    return lines.reduce((sum, each) => sum + Buffer.byteLength(each) + 1, 0);
  }

  const FORGERIES = [
    ['hides lines: it says a block starts further on', 6],
    ['says a block starts in the middle of a line', -1],
  ] as const;
  const READS = [
    ['a tail', { tail: 5 }],
    ['a cursor', { after: 's4' }],
  ] as const;

  it.each(
    FORGERIES.flatMap(([forgery, place]) =>
      READS.map(([read, from]) => [forgery, read, place, from] as const),
    ),
  )(
    'is found when it %s, by %s that begins there, on its own: the right entries are sent and the index is made again',
    async (_forgery, _read, place, from) => {
      const { path: log, indexPath } = await written(2 * EVERY + 2);
      const real = await offsetOfLine({ log, place: EVERY });
      // A place that is mid-line is a few bytes into the second block's first line.
      const wrong = place < 0 ? real + 7 : await offsetOfLine({ log, place });

      // The second block's offset, in an index that is valid in every other way.
      const index = JSON.parse(await readFile(indexPath, 'utf8')) as { offsets: number[] };

      index.offsets[1] = wrong;
      await writeFile(indexPath, JSON.stringify(index));

      // Both reads begin in the second block, and each is the first this process makes.
      expect(await cursorsFrom(fileOf().log, from)).toEqual(range(5, 2 * EVERY + 2));
      expect((await indexOf()).offsets).toEqual([
        0,
        real,
        await offsetOfLine({ log, place: 2 * EVERY }),
      ]);
    },
  );

  it('is not blamed for a damaged log: what the read finds is left as it was, and so is the index', async () => {
    const { path: log } = await written(2 * EVERY + 2);

    // A line inside what the index covers is damaged without changing its length.
    await edit({ place: log, text: '"cursor":"s5"', by: '"cursor":"s5,' });

    const restarted = fileOf().log;

    vi.mocked(createReadStream).mockClear();

    // Three reads begin in the block with the damage together: each fails and says where. One of them
    // read the whole log to tell the log's damage from the index's, and the others did not.
    const together = await Promise.allSettled([
      cursorsFrom(restarted, { tail: 5 }),
      cursorsFrom(restarted, { after: 's4' }),
      cursorsFrom(restarted, { tail: 5 }),
    ]);

    expect(together).toHaveLength(3);

    for (const outcome of together) {
      expect(outcome).toMatchObject({
        status: 'rejected',
        reason: { name: 'StoreError', message: expect.stringContaining('line 6') as string },
      });
    }

    expect(wholeReads()).toBe(1);
    // A read that meets it later fails without reading the log whole again; and the channel is as it
    // was: it says what it holds, takes a line, and its index was not thrown away for the log's fault.
    await expect(cursorsFrom(restarted, { tail: 5 })).rejects.toMatchObject({ name: 'StoreError' });
    expect(wholeReads()).toBe(1);
    expect(await restarted.head()).toMatchObject({ count: 2 * EVERY + 2 });
    await restarted.append(entry(`s${String(2 * EVERY + 2)}`));
    expect(await cursorsFrom(restarted, { tail: 2 })).toEqual(range(2 * EVERY + 1, 2 * EVERY + 3));
    expect(await indexOf()).toMatchObject({ count: 2 * EVERY });
  });

  it('is replaced once for reads that fail on the same wrong places together', async () => {
    const { path: log, indexPath } = await written(2 * EVERY + 2);
    const index = JSON.parse(await readFile(indexPath, 'utf8')) as { offsets: number[] };

    index.offsets[1] = await offsetOfLine({ log, place: 6 });
    await writeFile(indexPath, JSON.stringify(index));

    const restarted = fileOf().log;

    vi.mocked(createReadStream).mockClear();

    const reads = await Promise.all(
      [1, 2, 3, 4].map(async () => cursorsFrom(restarted, { tail: 5 })),
    );

    expect(reads).toEqual([1, 2, 3, 4].map(() => range(5, 2 * EVERY + 2)));
    // One of them read the whole log, and the others started over on what it found.
    expect(wholeReads()).toBe(1);
  });

  it('is ignored for another channel’s, and none is kept for a byte channel', async () => {
    const { indexPath } = await written(2 * EVERY + 2);
    const other = fileOf('other');

    for (const each of sequence(2 * EVERY + 2)) {
      await other.log.append({ ...each, channel: 'other' });
    }

    // `other` is given `main`'s index, which says its last line is a line of `main`: the log has,
    // at that place, a line of `other`.
    await writeFile(other.indexPath, await readFile(indexPath, 'utf8'));
    expect(await fileOf('other').log.head()).toMatchObject({ count: 2 * EVERY + 2 });
    // It was not taken: the log was read whole and `other`'s own index written over it.
    const made = JSON.parse(await readFile(other.indexPath, 'utf8')) as {
      last: { channel: string };
    };

    expect(made.last.channel).toBe('other');

    const bytes = fileOf('t1');

    for (let at = 0; at < 3 * EVERY; at += 1) {
      await bytes.log.append(entry(`b${String(at * 10)}`, 't1'));
    }

    await expect(readFile(bytes.indexPath)).rejects.toMatchObject({ code: 'ENOENT' });
    expect(await cursorsFrom(fileOf('t1').log, { after: 'b10' })).toHaveLength(3 * EVERY - 2);
  });

  it('keeps exact places for lines of any text, in any bytes', async () => {
    const { log } = fileOf();
    const lines = sequence(2 * EVERY + 2).map((each) => ({
      ...each,
      node: { id: 'main', title: '日本語 🎉 é — naïve' },
    }));

    for (const each of lines) await log.append(each);

    const restarted = fileOf().log;

    expect(await cursorsFrom(restarted, { after: 's5' })).toEqual(range(6, 2 * EVERY + 2));
    expect(await cursorsFrom(restarted, { tail: 5 })).toEqual(range(2 * EVERY - 3, 2 * EVERY + 2));
  });

  it('carries on past a write that was cut off by a crash', async () => {
    const { path: file } = await written(2 * EVERY + 2);

    // The process died in the middle of a line.
    await appendFile(file, '{"channel":"main","cursor":"s1');

    const restarted = fileOf().log;

    expect(await restarted.head()).toMatchObject({ count: 2 * EVERY + 2 });
    await restarted.append(entry(`s${String(2 * EVERY + 2)}`));
    expect(await cursorsFrom(restarted, { tail: 2 })).toEqual(range(2 * EVERY + 1, 2 * EVERY + 3));
  });

  it('is forgotten with the folder: a channel made again under the name starts from nothing', async () => {
    const { log, indexPath } = await written(2 * EVERY + 1);

    await rm(path.dirname(indexPath), { recursive: true });
    await log.forget();
    await log.append(entry('s0'));

    expect(await log.head()).toMatchObject({ count: 1, newest: { cursor: 's0' } });
    await expect(readFile(indexPath)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('is not needed to append: a write of it that fails leaves the entry stored', async () => {
    const { log, indexPath } = fileOf();

    // A folder where the index goes: the write of it fails, the append does not.
    await mkdir(indexPath, { recursive: true });

    for (const each of sequence(2 * EVERY)) await log.append(each);

    expect(await log.head()).toMatchObject({ count: 2 * EVERY });
    expect(await cursorsFrom(log, { tail: 2 })).toEqual(range(2 * EVERY - 2, 2 * EVERY));
  });
});

import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import type { StoredChunk } from '@sheavly/core/output/output.types';
import { useTempFolder } from '../../testing/temp-folder.fake.js';
import { FileOutputStore } from '../output-store.service.js';

const temp = useTempFolder('file-output-follow-');
const store = (limits?: ConstructorParameters<typeof FileOutputStore>[0]['limits']) =>
  new FileOutputStore({ folder: path.join(temp.path(), 'outputs'), ...(limits && { limits }) });

describe('following a capture as it is stored', () => {
  it('tells each chunk once it is stored, with the offset it starts at, in order', async () => {
    const writer = await store().create();
    const told: StoredChunk[] = [];

    writer.follow((chunk) => told.push(chunk));
    // é and ö are two bytes of UTF-8, so the offsets count bytes and not characters.
    writer.append('héllo ');
    writer.append('wörld');
    writer.append('!');
    await writer.close();

    expect(told).toEqual([
      { offset: 0, text: 'héllo ' },
      { offset: 7, text: 'wörld' },
      { offset: 13, text: '!' },
    ]);
  });

  it('has told a chunk only when it can be read back, so a reader that follows and then reads misses none and repeats none', async () => {
    const outputs = store();
    const writer = await outputs.create();
    const told: (StoredChunk & { stored: number })[] = [];

    writer.follow((chunk) => told.push({ ...chunk, stored: writer.log.bytes }));
    writer.append('one ');
    writer.append('two ');
    writer.append('three');
    await writer.close();

    // When each was told, the log already held it: what a reader reads then includes it.
    for (const chunk of told) {
      expect(chunk.stored).toBeGreaterThanOrEqual(chunk.offset + Buffer.byteLength(chunk.text));
    }

    // Each starts where the one before it ended, and what the store holds is exactly what was told.
    expect(told.map((chunk) => chunk.offset)).toEqual([0, 4, 8]);

    const read = await outputs.read({ ref: writer.log.ref, offset: 0, maxBytes: 100 });

    expect(read.text).toBe(told.map((chunk) => chunk.text).join(''));
  });

  it('does not tell a chunk that was dropped for a limit, nor any after it', async () => {
    const writer = await store({ maxLogBytes: 10 }).create();
    const told: StoredChunk[] = [];

    writer.follow((chunk) => told.push(chunk));
    writer.append('aaaaaa');
    // Past the limit: dropped, and so is what comes after it, though that would have fit.
    writer.append('bbbbbbbb');
    writer.append('c');

    const closed = await writer.close();

    expect(told).toEqual([{ offset: 0, text: 'aaaaaa' }]);
    expect(closed).toMatchObject({ status: 'incomplete', bytes: 6 });
  });

  it('stops telling a follower that stopped following, and the others go on', async () => {
    const writer = await store().create();
    const first: string[] = [];
    const second: string[] = [];
    const stop = writer.follow((chunk) => first.push(chunk.text));

    writer.follow((chunk) => second.push(chunk.text));
    writer.append('a');
    await writer.close();
    stop();

    expect(first).toEqual(['a']);
    expect(second).toEqual(['a']);

    // Once stopped, a second capture's chunks do not reach it.
    const next = await store().create();

    next.append('b');
    await next.close();

    expect(first).toEqual(['a']);
  });

  it('tells nothing to a follower of a capture that stored nothing', async () => {
    const writer = await store().create();
    const told: StoredChunk[] = [];

    writer.follow((chunk) => told.push(chunk));
    await writer.close();

    expect(told).toEqual([]);
  });

  it('is not stopped by a follower that throws: the capture, and the others, go on, and its error is rethrown on its own', async () => {
    const writer = await store().create();
    const rethrown: (() => void)[] = [];
    // The error is rethrown from a microtask so it fails loudly; catch that here instead.
    const spy = vi.spyOn(globalThis, 'queueMicrotask').mockImplementation((run) => {
      rethrown.push(run);
    });
    const heard: string[] = [];

    writer.follow(() => {
      throw new Error('follower bug');
    });
    writer.follow((chunk) => heard.push(chunk.text));
    writer.append('one');
    writer.append('two');

    const closed = await writer.close();

    spy.mockRestore();

    expect(heard).toEqual(['one', 'two']);
    expect(closed).toMatchObject({ status: 'complete', bytes: 6 });
    expect(rethrown).toHaveLength(2);
    expect(() => rethrown[0]?.()).toThrow('follower bug');
  });
});

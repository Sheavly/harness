import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { useTempFolder } from '../../testing/temp-folder.fake.js';
import { OrderedAppends } from '../ordered-appends.service.js';

const temp = useTempFolder('ordered-appends-');

async function numbers(file: string): Promise<number[]> {
  const text = await readFile(file, 'utf8');

  return text
    .trim()
    .split('\n')
    .map((line) => (JSON.parse(line) as { n: number }).n);
}

describe('ordered appends', () => {
  it('writes lines in the order they were asked for, though nobody waits for each', async () => {
    const file = path.join(temp.path(), 'logs', 'x.jsonl');
    const appends = new OrderedAppends({ file });
    const asked = Array.from({ length: 200 }, (_unused, n) => appends.append({ value: { n } }));

    await Promise.all(asked);
    expect(await numbers(file)).toEqual(Array.from({ length: 200 }, (_unused, n) => n));
  });

  it('goes on writing after a line that failed, and tells that line’s caller', async () => {
    const file = path.join(temp.path(), 'y.jsonl');
    const appends = new OrderedAppends({ file });
    // A BigInt has no JSON form: this line cannot be written.
    const failed = appends.append({ value: { n: 1n } });
    const after = appends.append({ value: { n: 2 } });

    await expect(failed).rejects.toMatchObject({ name: 'StorageFileError' });
    await after;
    expect(await numbers(file)).toEqual([2]);
  });

  it('drops a line its `unless` says no to when it is about to be written, not when it is asked for', async () => {
    const file = path.join(temp.path(), 'z.jsonl');
    const appends = new OrderedAppends({ file });
    let stop = false;
    const first = appends.append({ value: { n: 1 }, unless: () => stop });
    const second = appends.append({ value: { n: 2 }, unless: () => stop });

    // Nothing has been written yet: the first line only starts once this turn has ended.
    stop = true;
    await Promise.all([first, second]);
    await appends.settled();
    await expect(readFile(file, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('settles only once every line asked for so far is done', async () => {
    const file = path.join(temp.path(), 'w.jsonl');
    const appends = new OrderedAppends({ file });

    void appends.append({ value: { n: 1 } });
    void appends.append({ value: { n: 2 } });
    await appends.settled();
    expect(await numbers(file)).toEqual([1, 2]);
  });
});

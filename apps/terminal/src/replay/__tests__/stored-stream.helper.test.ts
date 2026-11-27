import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { ReplayNotFoundError } from '../../errors/replay.errors.js';
import { useTempFolders } from '../../testing/temp-folders.fake.js';
import { readStoredStream } from '../stored-stream.helper.js';
import { asJsonl, asSse, fixtureEntries, oldFormEntries } from '../testing/stream.fake.js';

const temp = useTempFolders();

describe('readStoredStream', () => {
  it('reads a conversation folder from its stream.jsonl', async () => {
    const folder = await temp.make('replay');

    await writeFile(path.join(folder, 'stream.jsonl'), asJsonl(fixtureEntries()));

    const stream = await readStoredStream(folder);

    expect(stream).toMatchObject({ source: 'conversation', truncatedLastLine: false });
    expect(stream.entries).toEqual(fixtureEntries());
  });

  it('reads a workbook run folder from its sessions.sse, past heartbeats and the head frame', async () => {
    const folder = await temp.make('replay');

    await writeFile(path.join(folder, 'sessions.sse'), asSse(fixtureEntries()));

    const stream = await readStoredStream(folder);

    expect(stream.source).toBe('run');
    expect(stream.entries).toEqual(fixtureEntries());
    expect(stream.invalidLines).toEqual([]);
  });

  it.each([
    ['stream.jsonl', asJsonl],
    ['sessions.sse', asSse],
  ])(
    'reads what an older version wrote into %s: nothing is dropped as not an entry',
    async (name, write) => {
      const folder = await temp.make('replay');

      await writeFile(path.join(folder, name), write([...fixtureEntries(), ...oldFormEntries()]));

      const stream = await readStoredStream(folder);
      const [idle, queued] = stream.entries.slice(-2);

      expect(stream.invalidLines).toEqual([]);
      expect(stream.entries).toHaveLength(fixtureEntries().length + 2);
      expect(idle).toMatchObject({ update: { type: 'session_idle', session: { effort: 'high' } } });
      expect(queued).toMatchObject({ kind: 'queue', update: { type: 'prompt_started' } });
    },
  );

  it('does not read the last line when a crash cut it off, and says so', async () => {
    const folder = await temp.make('replay');
    const whole = asJsonl(fixtureEntries());

    await writeFile(path.join(folder, 'stream.jsonl'), `${whole}{"seq":9,"sessionId":"ma`);

    const stream = await readStoredStream(folder);

    expect(stream.truncatedLastLine).toBe(true);
    expect(stream.entries).toHaveLength(fixtureEntries().length);
  });

  it('counts a line that is not an entry without quoting it', async () => {
    const folder = await temp.make('replay');
    const [first, ...rest] = asJsonl(fixtureEntries()).split('\n');

    await writeFile(
      path.join(folder, 'stream.jsonl'),
      [first, 'not json: secret-token', '{"seq":1}', ...rest].join('\n'),
    );

    const stream = await readStoredStream(folder);

    expect(stream.invalidLines).toEqual([2, 3]);
    expect(JSON.stringify(stream)).not.toContain('secret-token');
  });

  it('reports a cut-off server-sent event frame', async () => {
    const folder = await temp.make('replay');

    await writeFile(
      path.join(folder, 'sessions.sse'),
      `${asSse(fixtureEntries())}event: entry\nid: 9\ndata: {"seq":9`,
    );

    expect((await readStoredStream(folder)).truncatedLastLine).toBe(true);
  });

  it('refuses a folder without a stored stream, naming what it expected', async () => {
    const folder = await temp.make('replay');

    await mkdir(path.join(folder, 'agents'));

    await expect(readStoredStream(folder)).rejects.toThrow(ReplayNotFoundError);
    await expect(readStoredStream(folder)).rejects.toThrow(/stream\.jsonl.*sessions\.sse/);
  });
});

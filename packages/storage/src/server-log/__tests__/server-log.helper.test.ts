import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { useTempFolder, expectPrivate } from '../../testing/temp-folder.fake.js';
import { serverLogSink } from '../server-log.helper.js';

const temp = useTempFolder('server-log-');

describe('the server log sink', () => {
  it('appends entries to <home>/logs/backend.jsonl, privately, making the folder', async () => {
    const sink = serverLogSink({ home: temp.path() });
    const file = path.join(temp.path(), 'logs', 'backend.jsonl');

    await sink({ level: 'error', event: 'server.start_failed', time: 1, service: 'backend' });
    await sink({ level: 'warn', event: 'server.extension_problem', time: 2, service: 'backend' });

    const events = (await readFile(file, 'utf8'))
      .trim()
      .split('\n')
      .map((line) => (JSON.parse(line) as { event: string }).event);

    expect(events).toEqual(['server.start_failed', 'server.extension_problem']);
    await expectPrivate(file);
  });

  it('refuses a home that is not an absolute folder', () => {
    expect(() => serverLogSink({ home: 'relative/home' })).toThrow();
  });
});

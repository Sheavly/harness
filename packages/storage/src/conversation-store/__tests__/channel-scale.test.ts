import { createWriteStream } from 'node:fs';
import { mkdir, stat } from 'node:fs/promises';
import path from 'node:path';
import { finished } from 'node:stream/promises';
import { describe, expect, it } from 'vitest';
import type { ChannelEntry } from '@sheavly/core/store/store.types';
import { useTempFolder } from '../../testing/temp-folder.fake.js';
import { ChannelFile } from '../channel-file.service.js';
import { ChannelQuota } from '../channel-quota.service.js';
import { DEFAULT_CHANNEL_LIMITS } from '../conversation-store.constants.js';

/**
 * How many entries the scale test builds, from the environment: `CHANNEL_SCALE_ENTRIES=1000000
 * npx vitest run … channel-scale`. Unset, it does not run: building a log of that size takes a
 * while, and what it reports is read by a person, not asserted past a generous bound.
 */
const ENTRIES = Number(process.env.CHANNEL_SCALE_ENTRIES ?? 0);

/** Roughly what a stream entry of a real run costs as a line, measured on two workbook runs. */
const LINE_BYTES = 360;

const temp = useTempFolder('channel-scale-');

const line = (n: number): string => {
  const base = {
    channel: 'main',
    type: n === 0 ? 'opened' : 'updated',
    cursor: `s${String(n)}`,
    at: 1,
    node: { id: 'main', title: 'Chat' },
  };
  const bare = JSON.stringify({ ...base, pad: '' }).length + 1;

  return `${JSON.stringify({ ...base, pad: 'x'.repeat(Math.max(0, LINE_BYTES - bare)) })}\n`;
};

/** Writes `count` entries as a channel's file, as a long conversation would have left it. */
async function writeChannel(params: { file: string; count: number }) {
  await mkdir(path.dirname(params.file), { recursive: true });

  const out = createWriteStream(params.file);

  for (let from = 0; from < params.count; from += 10_000) {
    let block = '';

    for (let n = from; n < Math.min(from + 10_000, params.count); n += 1) block += line(n);

    if (!out.write(block)) await new Promise((resolve) => out.once('drain', resolve));
  }

  out.end();
  await finished(out);
}

const ms = (since: number) => Math.round(performance.now() - since);
const mib = (bytes: number) => (bytes / 1024 / 1024).toFixed(0);

/** Reads from `from` and takes `take` entries, then leaves: what a subscription that asks for a window does. */
async function window(params: {
  log: ChannelFile;
  from: { tail: number } | { after: string };
  take: number;
}) {
  const entries: ChannelEntry[] = [];

  for await (const each of params.log.read(params.from)) {
    entries.push(each);

    if (entries.length >= params.take) break;
  }

  return entries.length;
}

describe.runIf(ENTRIES > 0)('a channel of a very long conversation', () => {
  it(
    'answers head, a tail and a cursor without reading the rest, and says what that costs',
    async () => {
      const folder = path.join(temp.path(), 'channels');
      const file = path.join(folder, 'main.jsonl');
      const report: string[] = [];

      await writeChannel({ file, count: ENTRIES });

      const size = (await stat(file)).size;
      // A new one each time, as a process that starts is: it knows only what is on disk.
      const open = () =>
        new ChannelFile({
          file,
          markerFile: path.join(folder, 'main.full'),
          indexFile: path.join(folder, 'main.idx'),
          channel: 'main',
          quota: new ChannelQuota({ folder, limits: DEFAULT_CHANNEL_LIMITS }),
        });
      const before = process.memoryUsage();
      const cold = performance.now();

      // No index yet: every line is read and validated, and the index is written.
      expect((await open().head()).count).toBe(ENTRIES);

      const coldMs = ms(cold);
      const warm = performance.now();
      const log = open();

      // The index is there: the last line is checked and the lines after it are read.
      expect((await log.head()).count).toBe(ENTRIES);

      const warmMs = ms(warm);

      report.push(
        `${String(ENTRIES)} entries, ${mib(size)} MiB on disk, an index of ${String((await stat(path.join(folder, 'main.idx'))).size)} bytes`,
        `first ask of a channel with no index (read and validate every line, write the index): ${String(coldMs)} ms`,
        `first ask of a channel after a restart (check the index, read the lines after it): ${String(warmMs)} ms`,
      );

      const timed = async (name: string, run: () => Promise<number>, times = 20) => {
        const start = performance.now();
        let taken = 0;

        for (let n = 0; n < times; n += 1) taken = await run();

        report.push(
          `${name}: ${((performance.now() - start) / times).toFixed(1)} ms each, ${String(taken)} entries`,
        );
      };

      await timed('tail 100', () => window({ log, from: { tail: 100 }, take: 100 }));
      await timed('tail 1000', () => window({ log, from: { tail: 1000 }, take: 1000 }));
      await timed('100 after the middle', () =>
        window({ log, from: { after: `s${String(Math.floor(ENTRIES / 2))}` }, take: 100 }),
      );
      await timed('100 after the first', () => window({ log, from: { after: 's0' }, take: 100 }));
      await timed('the entries after the last but 10', () =>
        window({ log, from: { after: `s${String(ENTRIES - 11)}` }, take: 100 }),
      );

      const after = process.memoryUsage();

      report.push(
        `memory: rss ${mib(before.rss)} to ${mib(after.rss)} MiB, heap ${mib(before.heapUsed)} to ${mib(after.heapUsed)} MiB`,
      );
      process.stdout.write(`\n${report.join('\n')}\n`);

      // Generous: the point is the numbers above. A restart that read the log would take seconds.
      expect(warmMs).toBeLessThan(2_000);
    },
    30 * 60_000,
  );
});

import { describe, expect, it } from 'vitest';
import { taskEntry as entry } from '../../testing/sse-body.fake.js';
import { readEntries, readFrames } from '../entries.helper.js';

/** A body that sends `chunks` as they are, split wherever a network might split them. */
const body = (chunks: string[]) =>
  new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(new TextEncoder().encode(chunk));
      controller.close();
    },
  });

const frame = (seq: number, newline = '\n') =>
  [`event: entry`, `id: ${String(seq)}`, `data: ${JSON.stringify(entry(seq))}`, '', ''].join(
    newline,
  );

async function read(chunks: string[]) {
  const seen: string[] = [];

  for await (const { cursor } of readEntries(body(chunks))) seen.push(cursor);

  return seen;
}

describe('readEntries', () => {
  it('reads every entry frame, whole or split across chunks, CRLF too', async () => {
    const both = frame(0) + frame(1, '\r\n');

    expect(await read([both])).toEqual(['0', '1']);
    expect(await read([both.slice(0, 7), both.slice(7, 40), both.slice(40)])).toEqual(['0', '1']);
  });

  it('skips heartbeats and frames that are not entries', async () => {
    expect(await read([': heartbeat\n\n', 'event: other\ndata: {}\n\n', frame(3)])).toEqual(['3']);
  });

  it('refuses an entry the protocol does not allow', async () => {
    const bad = 'event: entry\nid: 1\ndata: {"seq":1,"kind":"nope"}\n\n';

    await expect(read([bad])).rejects.toThrow();
  });

  it('passes through an extension event of a kind it has never heard of', async () => {
    const extensionEntry = {
      seq: 5,
      at: 1,
      sessionId: 'main',
      kind: 'event',
      event: {
        seq: 0,
        type: 'extension_event',
        extension: 'acme',
        kind: 'acme.never-heard-of',
        version: 3,
        data: { anything: [1, 2, 3] },
        text: 'Something happened',
      },
    };
    const sse = `event: entry\nid: 5\ndata: ${JSON.stringify(extensionEntry)}\n\n`;
    const read = [];

    for await (const { entry: parsed } of readEntries(body([sse]))) read.push(parsed);

    expect(read).toEqual([extensionEntry]);
  });

  it('reads an entry whose text holds U+2028 or U+2029, which JSON leaves unescaped', async () => {
    const started = entry(7);
    const withSeparators = {
      ...started,
      update: {
        ...started.update,
        task: { ...started.update.task, output: 'before\u2028middle\u2029after' },
      },
    };
    const sse = `event: entry\nid: 7\ndata: ${JSON.stringify(withSeparators)}\n\n`;
    const read = [];

    for await (const { entry: parsed } of readEntries(body([sse]))) read.push(parsed);

    expect(read).toEqual([withSeparators]);
  });

  it('reads nothing from no body', async () => {
    const seen: unknown[] = [];

    for await (const frameRead of readEntries(null)) seen.push(frameRead);
    expect(seen).toEqual([]);
  });

  it('skips a head frame, an id and nothing else', async () => {
    expect(await read(['id: 41\n\n', frame(42)])).toEqual(['42']);
  });
});

describe('readFrames', () => {
  it('gives a head frame with its cursor and no entry, before the entries', async () => {
    const seen: { cursor: string; entry: boolean }[] = [];

    for await (const { cursor, entry: parsed } of readFrames(
      body([': heartbeat\n\n', 'id: 41\n\n', frame(42)]),
    )) {
      seen.push({ cursor, entry: parsed !== undefined });
    }

    expect(seen).toEqual([
      { cursor: '41', entry: false },
      { cursor: '42', entry: true },
    ]);
  });
});

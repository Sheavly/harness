import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { createLogger } from '@sheavly/logger/logger/logger.helper';
import { CONVERSATION, entry } from '@sheavly/testing/store/store-contract.fake';
import { useTempFolder, expectPrivate } from '../../testing/temp-folder.fake.js';
import { FileConversationStore } from '../conversation-store.service.js';

const temp = useTempFolder('conversation-log-sink-');

function open() {
  const store = new FileConversationStore({ folder: temp.path(), onProblem: () => undefined });
  const file = path.join(temp.path(), 'conversations', CONVERSATION, 'log.jsonl');

  return { store, file };
}

describe('a conversation log sink', () => {
  it('appends each entry to the conversation’s log.jsonl, privately, in order', async () => {
    const { store, file } = open();
    const sink = store.logSink(CONVERSATION);

    await sink({ level: 'info', event: 'a.one', time: 1, service: 'backend' });
    await sink({ level: 'error', event: 'a.two', time: 2, service: 'backend' });

    const written = (await readFile(file, 'utf8')).trim().split('\n');

    expect(written.map((line) => (JSON.parse(line) as { event: string }).event)).toEqual([
      'a.one',
      'a.two',
    ]);
    await expectPrivate(file);
  });

  it('is what a logger writes through, with the conversation id and the error chain', async () => {
    const { store, file } = open();
    const logger = createLogger({
      service: 'backend',
      sinks: [store.logSink(CONVERSATION)],
    }).child({ conversationId: CONVERSATION });

    logger.error('api.request_failed', {
      error: new Error('outer', { cause: new Error('inner password=hunter2') }),
    });
    await new Promise((resolve) => setTimeout(resolve, 50));

    const line = JSON.parse((await readFile(file, 'utf8')).trim()) as Record<string, unknown>;

    expect(line).toMatchObject({
      conversationId: CONVERSATION,
      error: { message: 'outer', causes: [{ message: 'inner password=[REDACTED]' }] },
    });
  });

  it('writes beside the failures the stream records: one file', async () => {
    const { store, file } = open();

    await store.entries(CONVERSATION).append(entry(0));
    await store.logSink(CONVERSATION)({ level: 'warn', event: 'a.one', time: 1, service: 'x' });
    expect((await stat(file)).isFile()).toBe(true);
  });

  it('writes in the order given, though the caller waits for none, even from two sinks of one conversation', async () => {
    const { store, file } = open();
    const first = store.logSink(CONVERSATION);
    const second = store.logSink(CONVERSATION);
    const asked = Array.from({ length: 100 }, (_unused, n) =>
      (n % 2 === 0 ? first : second)({ level: 'info', event: 'a.n', time: n, service: 'x' }),
    );

    await Promise.all(asked.map((pending) => Promise.resolve(pending)));

    const times = (await readFile(file, 'utf8'))
      .trim()
      .split('\n')
      .map((line) => (JSON.parse(line) as { time: number }).time);

    expect(times).toEqual(Array.from({ length: 100 }, (_unused, n) => n));
  });

  it('waits for entries already asked for when the conversation is deleted, and leaves no folder', async () => {
    const { store, file } = open();

    await store.entries(CONVERSATION).append(entry(0));

    const sink = store.logSink(CONVERSATION);
    const pending = Array.from({ length: 20 }, (_unused, n) =>
      sink({ level: 'error', event: 'a.n', time: n, service: 'x' }),
    );

    await store.delete(CONVERSATION);
    await Promise.all(pending.map((line) => Promise.resolve(line)));
    await expect(stat(path.dirname(file))).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('drops an entry once the conversation is deleted, so its folder does not come back', async () => {
    const { store, file } = open();

    await store.entries(CONVERSATION).append(entry(0));
    await store.delete(CONVERSATION);
    await store.logSink(CONVERSATION)({ level: 'error', event: 'a.late', time: 1, service: 'x' });
    await expect(stat(file)).rejects.toMatchObject({ code: 'ENOENT' });
  });
});

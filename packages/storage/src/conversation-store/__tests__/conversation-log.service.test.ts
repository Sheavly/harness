import { appendFile, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { useTempFolder, expectPrivate } from '../../testing/temp-folder.fake.js';
import { CONVERSATION, entry } from '@sheavly/testing/store/store-contract.fake';
import { messageIdSchema } from '@sheavly/protocol/message/message.validator';
import { sessionIdSchema } from '@sheavly/protocol/session/session.validator';
import type { StreamEntry } from '@sheavly/protocol/stream/stream.types';
import { FileConversationStore } from '../conversation-store.service.js';

const temp = useTempFolder('conversation-log-');
const messageId = messageIdSchema.parse('00000000-0000-4000-8000-000000000001');
const main = sessionIdSchema.parse('main');

function failure(seq: number): StreamEntry {
  return {
    seq,
    at: 1234,
    sessionId: main,
    messageId,
    kind: 'event',
    event: {
      seq,
      type: 'run_failed',
      error: 'API failed password=secret',
      session: { id: main, rootId: main, depth: 1 },
    },
  };
}

function open() {
  const store = new FileConversationStore({ folder: temp.path(), onProblem: () => undefined });

  return { store, folder: path.join(temp.path(), 'conversations', CONVERSATION) };
}

async function lines(folder: string) {
  const text = await readFile(path.join(folder, 'log.jsonl'), 'utf8');

  return text
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

describe('a conversation log', () => {
  it('writes failure metadata, correlated to a message, and excludes ordinary transcript entries', async () => {
    const { store, folder } = open();
    const stream = store.entries(CONVERSATION);

    await stream.append(entry(0));
    await stream.append(failure(1));
    expect(await lines(folder)).toMatchObject([
      {
        level: 'error',
        event: 'run.failed',
        time: 1234,
        service: 'storage',
        seq: 1,
        conversationId: CONVERSATION,
        sessionId: main,
        messageId,
        error: { message: 'API failed password=[REDACTED]' },
      },
    ]);
    await expectPrivate(path.join(folder, 'log.jsonl'));
  });

  it('repairs a missing or partial write from the stream on restart, without duplicates', async () => {
    const { store, folder } = open();

    await store.entries(CONVERSATION).append(failure(0));
    await appendFile(path.join(folder, 'log.jsonl'), '{"partial":');
    await open().store.entries(CONVERSATION).append(failure(1));
    expect((await lines(folder)).map((line) => line.seq)).toEqual([0, 1]);

    await rm(path.join(folder, 'log.jsonl'));
    await open().store.entries(CONVERSATION).append(entry(2));
    expect((await lines(folder)).map((line) => line.seq)).toEqual([0, 1]);
  });

  it('does not replay an entry the backend logged, which has no seq', async () => {
    const { store, folder } = open();

    await store.entries(CONVERSATION).append(failure(0));
    await store.logSink(CONVERSATION)({
      level: 'error',
      event: 'api.request_failed',
      time: 1,
      service: 'backend',
    });
    await open().store.entries(CONVERSATION).append(failure(1));
    expect((await lines(folder)).map((line) => line.event)).toEqual([
      'run.failed',
      'api.request_failed',
      'run.failed',
    ]);
  });

  it('is not held back by an entry the backend logged with a seq of its own', async () => {
    const { store, folder } = open();

    await store.logSink(CONVERSATION)({
      level: 'error',
      event: 'api.request_failed',
      time: 1,
      service: 'backend',
      seq: 99,
    });
    await open().store.entries(CONVERSATION).append(failure(0));
    expect((await lines(folder)).map((line) => line.event)).toEqual([
      'api.request_failed',
      'run.failed',
    ]);
  });

  it('fails loudly when the log cannot be written', async () => {
    const { store, folder } = open();

    await mkdir(path.join(folder, 'log.jsonl'), { recursive: true });
    await expect(store.entries(CONVERSATION).append(failure(0))).rejects.toMatchObject({
      name: 'StoreError',
    });
  });

  it('backfills older run failures without inventing message IDs', async () => {
    const { folder } = open();
    const { messageId: _unknown, ...old } = failure(0);

    await mkdir(folder, { recursive: true });
    await writeFile(path.join(folder, 'stream.jsonl'), `${JSON.stringify(old)}\n`);
    await open().store.entries(CONVERSATION).append(entry(1));
    expect((await lines(folder))[0]).not.toHaveProperty('messageId');
  });
});

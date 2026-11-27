import { describe, expect, it } from 'vitest';
import type { MessageId } from '@sheavly/protocol/message/message.types';
import type { ConversationId } from '@sheavly/protocol/server/server.types';
import type { StreamEntry } from '@sheavly/protocol/stream/stream.types';
import { MemoryConversationStore } from '@sheavly/testing/store/memory-store.fake';
import { until } from '@sheavly/testing/wait/until.fake';
import {
  follow,
  heldConversations,
  idle,
  runningFirst,
  stoppableSkills,
} from '../../testing/held-conversations.fake.js';
import { mainChannelOf } from '../../testing/main-channel.fake.js';
import { storedTreeOf } from '../../testing/stored-tree.fake.js';
import type { Conversations } from '../conversations.service.js';

type World = { conversations: Conversations; id: ConversationId; store: MemoryConversationStore };

/** The lines of a stream that started, in order, each with the message id it started with. */
const startedOf = (entries: readonly StreamEntry[]) =>
  entries.flatMap((entry) =>
    entry.kind === 'queue' && entry.update.type === 'prompt_started'
      ? [[entry.update.text, entry.update.messageId] as const]
      : [],
  );

/** The `queue_changed` updates of a stream: the lines after, and the ids dropped. */
const changesOf = (entries: readonly StreamEntry[]) =>
  entries.flatMap((entry) =>
    entry.kind === 'queue' && entry.update.type === 'queue_changed'
      ? [{ queued: entry.update.queued, dropped: entry.update.dropped }]
      : [],
  );

/** Every entry of the stored tree channel of the conversation of `world`. */
const treeOf = (world: World) =>
  storedTreeOf({ ...world, harness: world.conversations.get(world.id).harness });

/** The user messages the main agent's channel says runs started for, as `text` and id. */
async function runStartsOf(world: World) {
  const { harness } = world.conversations.get(world.id);
  const entries = await mainChannelOf({ store: world.store, id: world.id, harness });

  return entries.flatMap((entry) =>
    entry.type === 'run_started'
      ? [['text' in entry ? entry.text : undefined, entry.messageId] as const]
      : [],
  );
}

/** A conversation kept in memory whose first prompt runs, held until `release(1)`. */
async function keptRunning() {
  const store = new MemoryConversationStore();
  const held = await runningFirst({ store });

  return { ...held, store, entries: follow(held) };
}

/**
 * A conversation whose line `second` is starting: the first run is released and `second`'s skills are
 * being prepared, held until a stop reaches them (`once`: only the first preparation of it is held).
 * Its stream is followed from before `second` was sent.
 */
async function startingSecond(params: { once: boolean }) {
  const { skills, reached } = stoppableSkills({ text: 'second', once: params.once });
  const held = await runningFirst({ skills });
  const entries = follow(held);
  const second = await held.send('second');

  held.release(1);
  await reached;

  return { ...held, entries, second };
}

describe('the message id a line has from the moment it is accepted', () => {
  it('is answered for a queued line, and is the id its stream and tree notices, its run’s start and its events carry', async () => {
    const world = await keptRunning();
    const { conversations, id, entries, release, prompts } = world;
    const queued = await world.send('second');

    expect(queued.status).toBe('queued');
    release(1);
    await until(() => prompts.length === 2);
    await idle({ conversations, id });

    const tree = (await treeOf(world)).findLast((entry) => entry.type === 'prompt_started');
    const run = entries.filter((entry) => entry.messageId === queued.messageId);

    expect(startedOf(entries)).toEqual([['second', queued.messageId]]);
    expect(tree).toMatchObject({ text: 'second', messageId: queued.messageId });
    expect((await runStartsOf(world)).at(-1)).toEqual(['second', queued.messageId]);
    expect(run.flatMap((entry) => (entry.kind === 'event' ? [entry.event.type] : []))).toContain(
      'done',
    );
  });

  it('is the id a prompt that starts at once answers with, on its start and its run', async () => {
    const store = new MemoryConversationStore();
    const { conversations, prompts } = heldConversations({ store });
    const id = await conversations.start();
    const entries = follow({ conversations, id });
    const sent = await conversations.submit({ id, prompt: { text: 'now' } });

    await until(() => prompts.length === 1);
    await idle({ conversations, id });

    expect(sent.status).toBe('started');
    expect(startedOf(entries)).toEqual([['now', sent.messageId]]);
    expect(await runStartsOf({ conversations, id, store })).toEqual([['now', sent.messageId]]);
    expect(entries.some((entry) => entry.messageId === sent.messageId)).toBe(true);
  });

  it('is its own for each of two identical lines queued at once, and each starts in order with its own', async () => {
    const world = await keptRunning();
    const { conversations, id, entries, release, prompts } = world;
    const one = await world.send('same');
    const two = await world.send('same');

    expect(one.messageId).not.toBe(two.messageId);
    release(1);
    await until(() => prompts.length === 3);
    await idle({ conversations, id });

    expect(startedOf(entries)).toEqual([
      ['same', one.messageId],
      ['same', two.messageId],
    ]);
    expect((await runStartsOf(world)).slice(1)).toEqual([
      ['same', one.messageId],
      ['same', two.messageId],
    ]);
  });

  it('is kept by a line a client’s edit leaves, made for a new one, and the ids of the lines it left out are dropped', async () => {
    const world = await keptRunning();
    const { conversations, id, entries, release, prompts } = world;
    const a = await world.send('a');
    const b = await world.send('b');

    await conversations.setQueue({ id, queued: ['b', 'c'] });
    release(1);
    await until(() => prompts.length === 3);
    await idle({ conversations, id });

    const started = startedOf(entries);

    expect(changesOf(entries).at(-1)).toEqual({ queued: ['b', 'c'], dropped: [a.messageId] });
    expect(started.map(([text]) => text)).toEqual(['b', 'c']);
    expect(started[0]?.[1]).toBe(b.messageId);
    expect([a.messageId, b.messageId]).not.toContain(started[1]?.[1]);
    expect((await treeOf(world)).filter((entry) => entry.type === 'queue_changed')).toContainEqual(
      expect.objectContaining({ queued: ['b', 'c'], dropped: [a.messageId] }),
    );
  });

  it('is reported as dropped for the line an edit removes, and for none when the same lines are put again', async () => {
    const { conversations, id, entries, send, release } = await keptRunning();
    const waiting = await send('waits');

    await conversations.setQueue({ id, queued: ['waits'] });
    expect(changesOf(entries)).toEqual([{ queued: ['waits'], dropped: undefined }]);

    await conversations.setQueue({ id, queued: [] });
    expect(changesOf(entries).at(-1)).toEqual({ queued: [], dropped: [waiting.messageId] });
    release(1);
  });

  it('is on the refusal of a line that cannot start, as the id it was answered with', async () => {
    const world = await keptRunning();
    const { conversations, id, entries, release } = world;
    const bad: MessageId = (await world.send('/nope')).messageId;

    release(1);
    await until(() =>
      entries.some((entry) => entry.kind === 'queue' && entry.update.type === 'prompt_refused'),
    );
    await idle({ conversations, id });

    expect(entries.flatMap((e) => (e.kind === 'queue' ? [e.update] : []))).toContainEqual(
      expect.objectContaining({ type: 'prompt_refused', text: '/nope', messageId: bad }),
    );
    expect((await treeOf(world)).find((entry) => entry.type === 'prompt_refused')).toMatchObject({
      text: '/nope',
      messageId: bad,
    });
  });

  it('is made again for the lines a reopen restores, which start with the new ids', async () => {
    const store = new MemoryConversationStore();
    const first = await runningFirst({ store });
    const { id } = first;
    const before = await first.send('kept');

    await first.conversations.close(id);

    const second = heldConversations({ store });

    await second.conversations.reopen(id);

    const entries = follow({ conversations: second.conversations, id });
    const next = await second.conversations.submit({ id, prompt: { text: 'new' } });

    await until(() => second.prompts.length === 2);
    await idle({ conversations: second.conversations, id });

    const started = startedOf(entries);

    expect(started.map(([text]) => text)).toEqual(['kept', 'new']);
    expect(started[0]?.[1]).not.toBe(before.messageId);
    expect(started[1]?.[1]).toBe(next.messageId);
    expect(await runStartsOf({ conversations: second.conversations, id, store })).toEqual(started);
  });

  it('is the same after a stop reaches a line preparing its skills, which waits parked for the next send', async () => {
    const held = await startingSecond({ once: true });
    const { id, conversations, entries, second } = held;

    conversations.stop(id);
    await idle({ conversations, id });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(startedOf(entries)).toEqual([]);

    await held.send('third');
    await until(() => held.prompts.length === 3);
    await idle({ conversations, id });

    expect(held.prompts).toEqual(['first', 'second', 'third']);
    expect(startedOf(entries).map(([text]) => text)).toEqual(['second', 'third']);
    expect(startedOf(entries)[0]?.[1]).toBe(second.messageId);
  });

  it('is not dropped by an edit that leaves out the line that is starting, and said to be gone if that line then does not start', async () => {
    const held = await startingSecond({ once: false });
    const { id, conversations, entries, second } = held;

    // The line is starting: its skills are being prepared. An edit that leaves it out cannot take
    // it back, so it is not reported as dropped yet.
    await conversations.setQueue({ id, queued: [] });
    expect(changesOf(entries).at(-1)).toEqual({ queued: [], dropped: undefined });

    // Stopped before it started, it is neither waiting nor running: the queue says so, once. (Three
    // changes by then: the line joining, the edit, and this.)
    conversations.stop(id);
    await until(() => changesOf(entries).length === 3);
    await idle({ conversations, id });

    expect(changesOf(entries).at(-1)).toEqual({ queued: [], dropped: [second.messageId] });
    expect(startedOf(entries)).toEqual([]);
    expect(held.prompts).toEqual(['first']);
  });
});

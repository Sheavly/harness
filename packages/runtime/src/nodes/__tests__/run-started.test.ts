import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  MAX_CHANNEL_ENTRY_CHARS,
  RUN_START_CAUSES,
} from '@sheavly/protocol/channel/channel.constants';
import { isWellFormedChannelLog } from '@sheavly/protocol/channel/channel.utils';
import { channelEntrySchema } from '@sheavly/protocol/channel/channel.validator';
import { agentEventSchema } from '@sheavly/protocol/event/event.validator';
import { callIdSchema, messageIdSchema } from '@sheavly/protocol/message/message.validator';
import { nodeIdSchema } from '@sheavly/protocol/node/node.validator';
import { MAX_QUEUED_LINE_CHARS } from '@sheavly/protocol/server/server.constants';
import { useFixedClock } from '@sheavly/testing/clock/fixed-clock.fake';
import { MemoryConversationStore } from '@sheavly/testing/store/memory-store.fake';
import { readChannel, shapeOf } from '../../testing/stored-channels.fake.js';
import { conversation, conversationId, entriesOf } from '../../testing/stored-conversation.fake.js';
import { TEXT_DELTA_WINDOW_MS } from '../nodes.constants.js';

const MESSAGE = messageIdSchema.parse('00000000-0000-4000-8000-000000000001');
const OTHER = messageIdSchema.parse('00000000-0000-4000-8000-000000000002');
const CALL = callIdSchema.parse('call_1');

useFixedClock();
beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
});

const world = (store?: MemoryConversationStore) => {
  const made = conversation(store ? { store } : {});

  return { ...made, node: made.nodeOf(made.main.id) };
};

type World = ReturnType<typeof world>;

/** Publishes a loop event of the main session, parsed with the protocol's schema first. */
function publish(params: { world: World; seq: number; body: object }) {
  const { world: made, seq, body } = params;

  made.sessions.publish({
    sessionId: made.main.id,
    event: agentEventSchema.parse({ seq, ...body }),
  });
}

const delta = (text: string) => ({ type: 'text_delta', text });

describe('where a run starts on an agent’s channel', () => {
  it('is stored in order with the run’s events, numbered after the entries before it', async () => {
    const made = world();

    made.writer.noteRunStarted({
      node: made.node,
      cause: 'prompt',
      messageId: MESSAGE,
      text: 'Inspect the project',
    });
    publish({ world: made, seq: 0, body: { type: 'usage', usage: { tokens: null } } });
    publish({ world: made, seq: 1, body: delta('done') });

    const entries = await entriesOf({ world: made, channel: made.node });

    expect(shapeOf(entries)).toEqual(['opened s0', 'run_started s1', 'event s2', 'event s3']);
    expect(entries[1]).toMatchObject({
      channel: made.node,
      cause: 'prompt',
      messageId: MESSAGE,
      text: 'Inspect the project',
    });
  });

  it('is numbered with the node’s own updates: each takes the next place', async () => {
    const made = world();

    made.sessions.idle({ id: made.main.id, outcome: 'completed' });
    made.sessions.resume(made.main.id);
    made.writer.noteRunStarted({ node: made.node, cause: 'wake', messageId: MESSAGE });
    publish({ world: made, seq: 0, body: delta('notice') });

    expect(shapeOf(await entriesOf({ world: made, channel: made.node }))).toEqual([
      'opened s0',
      'updated s1',
      'updated s2',
      'run_started s3',
      'event s4',
    ]);
  });

  it('comes after the text of the run before it that waits in its window', async () => {
    const made = world();

    publish({ world: made, seq: 0, body: delta('the last words') });
    made.writer.noteRunStarted({ node: made.node, cause: 'wake', messageId: OTHER });
    publish({ world: made, seq: 1, body: delta('a new run') });

    const entries = await entriesOf({ world: made, channel: made.node });

    expect(shapeOf(entries)).toEqual(['opened s0', 'event s1', 'run_started s2', 'event s3']);
    expect(entries[1]).toMatchObject({ event: { seq: 0, text: 'the last words' } });
    expect(entries[3]).toMatchObject({ event: { seq: 1, text: 'a new run' } });
  });

  it('does not let the next run’s text join the previous run’s, though it comes within the window', async () => {
    const made = world();

    publish({ world: made, seq: 0, body: delta('one ') });
    publish({ world: made, seq: 1, body: delta('two') });
    made.writer.noteRunStarted({ node: made.node, cause: 'wake', messageId: MESSAGE });
    publish({ world: made, seq: 2, body: delta('three') });
    await vi.advanceTimersByTimeAsync(TEXT_DELTA_WINDOW_MS);

    const entries = await readChannel({
      store: made.store,
      id: conversationId,
      channel: made.node,
    });

    expect(shapeOf(entries)).toEqual(['opened s0', 'event s1', 'run_started s2', 'event s3']);
    expect(entries[1]).toMatchObject({ event: { text: 'one two' }, lastSeq: 1 });
    expect(entries[3]).toMatchObject({ event: { text: 'three' } });
  });

  it.each(RUN_START_CAUSES)('is an entry the protocol serves, for a %s', async (cause) => {
    const made = world();

    made.writer.noteRunStarted({
      node: made.node,
      cause,
      messageId: MESSAGE,
      ...(cause === 'prompt' && { text: 'go' }),
    });

    const entries = await entriesOf({ world: made, channel: made.node });

    expect(entries.map((entry) => channelEntrySchema.safeParse(entry).success)).toEqual([
      true,
      true,
    ]);
  });

  it('has no text for a wake', async () => {
    const made = world();

    made.writer.noteRunStarted({ node: made.node, cause: 'wake', messageId: MESSAGE });

    const entries = await entriesOf({ world: made, channel: made.node });

    expect(entries[1]).toMatchObject({ cause: 'wake', messageId: MESSAGE });
    expect(entries[1]).not.toHaveProperty('text');
  });

  it('is read back from the store with the rest of the channel, as a reopened conversation reads it', async () => {
    const made = world();

    made.writer.noteRunStarted({
      node: made.node,
      cause: 'prompt',
      messageId: MESSAGE,
      text: 'hi',
    });
    publish({ world: made, seq: 0, body: delta('hello') });
    made.sessions.end({ id: made.main.id, state: 'completed' });
    await made.writer.flush();

    const read = await readChannel({ store: made.store, id: conversationId, channel: made.node });

    expect(shapeOf(read)).toEqual(['opened s0', 'run_started s1', 'event s2', 'closed s3']);
    expect(isWellFormedChannelLog(read)).toBe(true);
    expect(read.every((entry) => channelEntrySchema.safeParse(entry).success)).toBe(true);
    expect(read[1]).toMatchObject({ cause: 'prompt', messageId: MESSAGE, text: 'hi' });
  });
});

describe('the text of a prompt on its run’s start', () => {
  const textOf = async (text: string) => {
    const made = world();

    made.writer.noteRunStarted({ node: made.node, cause: 'prompt', messageId: MESSAGE, text });

    return (await entriesOf({ world: made, channel: made.node }))[1];
  };

  it('is kept whole up to a queued line’s length', async () => {
    const text = 'x'.repeat(MAX_QUEUED_LINE_CHARS);

    expect(await textOf(text)).toMatchObject({ text });
  });

  it('is cut to a queued line’s length, as the tree channel’s prompt_started is', async () => {
    const entry = await textOf('y'.repeat(MAX_QUEUED_LINE_CHARS + 500));

    expect(entry).toMatchObject({ text: 'y'.repeat(MAX_QUEUED_LINE_CHARS) });
  });

  it('is never cut inside a character of two units', async () => {
    const entry = await textOf(`${'a'.repeat(MAX_QUEUED_LINE_CHARS - 1)}😀`);

    expect(entry).toMatchObject({ text: 'a'.repeat(MAX_QUEUED_LINE_CHARS - 1) });
  });

  it('is shortened until the entry fits what a store keeps, when its characters cost more as JSON', async () => {
    // Control characters are six characters each as JSON: 20,000 of them would not fit.
    const entry = await textOf('\u0001'.repeat(MAX_QUEUED_LINE_CHARS));

    expect(JSON.stringify(entry).length).toBeLessThanOrEqual(MAX_CHANNEL_ENTRY_CHARS);
    expect(entry?.text).toBeTypeOf('string');
    expect(channelEntrySchema.safeParse(entry).success).toBe(true);
  });
});

describe('a node that takes no run start', () => {
  it('is one with no channel: nothing is stored and nothing throws', async () => {
    const made = world();

    made.writer.noteRunStarted({
      node: nodeIdSchema.parse('no-such-node'),
      cause: 'wake',
      messageId: MESSAGE,
    });

    expect(shapeOf(await entriesOf({ world: made, channel: made.node }))).toEqual(['opened s0']);
    expect(made.failures).toEqual([]);
  });

  it('is one whose channel closed: it takes nothing after its close', async () => {
    const made = world();
    const child = made.sessions.startChild({
      parentId: made.main.id,
      startedByCall: CALL,
      title: 'Reader',
    });
    const channel = made.nodeOf(child.id);

    made.sessions.end({ id: child.id, state: 'completed' });
    await entriesOf({ world: made, channel });
    made.writer.noteRunStarted({ node: channel, cause: 'wake', messageId: MESSAGE });

    expect(shapeOf(await entriesOf({ world: made, channel }))).toEqual(['opened s0', 'closed s1']);
    expect(made.failures).toEqual([]);
  });

  it('is one whose channel failed: it takes nothing and is not told of again', async () => {
    const store = new MemoryConversationStore();
    const made = world(store);

    await made.writer.flush();
    store.failWith(new Error('disk gone'));
    made.sessions.idle({ id: made.main.id, outcome: 'completed' });
    await made.writer.flush();
    store.failWith(undefined);
    made.writer.noteRunStarted({ node: made.node, cause: 'wake', messageId: MESSAGE });

    expect(shapeOf(await entriesOf({ world: made, channel: made.node }))).toEqual(['opened s0']);
    expect(made.failures).toHaveLength(1);
  });
});

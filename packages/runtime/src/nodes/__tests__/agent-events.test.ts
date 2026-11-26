import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { channelEntrySchema } from '@sheavly/protocol/channel/channel.validator';
import { agentEventSchema } from '@sheavly/protocol/event/event.validator';
import { callIdSchema, messageIdSchema } from '@sheavly/protocol/message/message.validator';
import type { SessionId } from '@sheavly/protocol/session/session.types';
import { useFixedClock } from '@sheavly/testing/clock/fixed-clock.fake';
import { readChannel, shapeOf } from '../../testing/stored-channels.fake.js';
import { conversation, conversationId, entriesOf } from '../../testing/stored-conversation.fake.js';
import { MAX_MERGED_TEXT_CHARS, TEXT_DELTA_WINDOW_MS } from '../nodes.constants.js';

const CALL = callIdSchema.parse('call_1');
const FIRST = messageIdSchema.parse('00000000-0000-4000-8000-000000000001');
const SECOND = messageIdSchema.parse('00000000-0000-4000-8000-000000000002');
const DESCRIBED = {
  call: { id: 'call_1', name: 'read_file', input: { path: 'a.ts' } },
  description: 'reading a.ts',
};

useFixedClock();
beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
});

const world = () => {
  const made = conversation();

  return { ...made, channel: made.nodeOf(made.main.id) };
};

type World = ReturnType<typeof world>;

/**
 * Publishes the event `body` with its own `seq`, as the main session's or as `session`'s. The event
 * is parsed with the protocol's schema first, so a test never publishes one the loop could not.
 */
function publish(params: { world: World; body: object; seq?: number; session?: SessionId }) {
  const { world: made, body, seq = 0, session = made.main.id } = params;

  made.sessions.publish({ sessionId: session, event: agentEventSchema.parse({ seq, ...body }) });
}

/** What `channel` (the main agent's by default) holds once the writes so far have landed. */
async function stored(made: World, channel = made.channel) {
  const entries = await entriesOf({ world: made, channel });

  return { entries, shape: shapeOf(entries) };
}

/** Starts a sub-agent of the main session, as a tool call does. */
const startChild = (made: World) =>
  made.sessions.startChild({ parentId: made.main.id, startedByCall: CALL, title: 'Reader' });

const delta = (text: string) => ({ type: 'text_delta', text });
const toolCall = () => ({ type: 'tool_call_started', ...DESCRIBED });

describe('an agent’s loop events on its channel', () => {
  it('are stored as event entries, in the order they came, numbered after opened', async () => {
    const made = world();

    publish({ world: made, seq: 0, body: toolCall() });
    publish({ world: made, seq: 1, body: { type: 'turn_end', turn: 0, stopReason: 'end_turn' } });

    const { entries, shape } = await stored(made);

    expect(shape).toEqual(['opened s0', 'event s1', 'event s2']);
    expect(entries[1]).toMatchObject({
      channel: made.channel,
      event: { seq: 0, type: 'tool_call_started', ...DESCRIBED },
    });
    expect(entries[2]).toMatchObject({ event: { seq: 1, type: 'turn_end', turn: 0 } });
  });

  it('are the entries the protocol serves, each with the channel it is on', async () => {
    const made = world();

    publish({ world: made, seq: 0, body: toolCall() });
    publish({ world: made, seq: 1, body: { type: 'usage', usage: { tokens: null } } });

    for (const entry of await entriesOf({ world: made, channel: made.channel })) {
      expect(channelEntrySchema.safeParse(entry).success).toBe(true);
    }
  });

  it('are numbered with the node’s own updates: each takes the next place', async () => {
    const made = world();

    publish({ world: made, seq: 0, body: toolCall() });
    made.sessions.report({ id: made.main.id, status: 'reading' });
    publish({ world: made, seq: 1, body: { type: 'turn_end', turn: 0, stopReason: 'end_turn' } });

    expect(shapeOf(await entriesOf({ world: made, channel: made.channel }))).toEqual([
      'opened s0',
      'event s1',
      'updated s2',
      'event s3',
    ]);
  });

  it('keep the user message they answer, when the stream’s entry had one', async () => {
    const made = world();

    made.sessions.setMessage({ sessionId: made.main.id, messageId: FIRST });
    publish({ world: made, seq: 0, body: toolCall() });

    expect((await entriesOf({ world: made, channel: made.channel }))[1]).toMatchObject({
      messageId: FIRST,
    });
  });

  it('are stored on the channel of the session that sent them: a sub-agent’s on its own', async () => {
    const made = world();
    const child = startChild(made);

    publish({ world: made, session: child.id, body: toolCall() });

    const own = await entriesOf({ world: made, channel: made.nodeOf(child.id) });
    const parent = await entriesOf({ world: made, channel: made.channel });

    expect(shapeOf(own)).toEqual(['opened s0', 'event s1']);
    expect(shapeOf(parent)).toEqual(['opened s0']);
  });

  it.each([
    ['a storage failure', { type: 'storage_failed', error: 'disk full' }],
    [
      'an extension’s own event',
      {
        type: 'extension_event',
        extension: 'acme',
        kind: 'acme.done',
        version: 1,
        data: {},
        text: 'Done',
      },
    ],
  ])('leave %s to the tree channel: an agent’s channel does not hold it', async (_name, body) => {
    const made = world();

    publish({ world: made, seq: 0, body });

    expect(shapeOf(await entriesOf({ world: made, channel: made.channel }))).toEqual(['opened s0']);
  });

  it('takes the run’s done after the agent ended, as the loop sends it, before the channel closes', async () => {
    const made = world();
    const child = startChild(made);

    // The loop ends a sub-agent's session and, in the same step, sends the run's last event.
    publish({ world: made, session: child.id, seq: 0, body: delta('finished') });
    made.sessions.end({ id: child.id, state: 'completed' });
    publish({
      world: made,
      session: child.id,
      seq: 1,
      body: { type: 'done', reason: 'completed', messages: [], session: child },
    });

    const entries = await entriesOf({ world: made, channel: made.nodeOf(child.id) });

    expect(shapeOf(entries)).toEqual(['opened s0', 'event s1', 'event s2', 'closed s3']);
    expect(entries[1]).toMatchObject({ event: { type: 'text_delta', text: 'finished' } });
    expect(entries[2]).toMatchObject({ event: { type: 'done', reason: 'completed' } });
  });

  it('closes an agent that ended with no done to wait for, at the end of the step', async () => {
    const made = world();
    const child = startChild(made);

    made.sessions.end({ id: child.id, state: 'completed' });

    // Read from the store with no flush of the writer: the close came by itself.
    await vi.waitFor(async () => {
      expect(
        shapeOf(
          await readChannel({
            store: made.store,
            id: conversationId,
            channel: made.nodeOf(child.id),
          }),
        ),
      ).toEqual(['opened s0', 'closed s1']);
    });
  });

  it('stops with the channel: nothing is stored after it closed', async () => {
    const made = world();
    const child = startChild(made);

    made.sessions.end({ id: child.id, state: 'completed' });
    await entriesOf({ world: made, channel: made.nodeOf(child.id) });
    publish({ world: made, session: child.id, body: toolCall() });

    expect(shapeOf(await entriesOf({ world: made, channel: made.nodeOf(child.id) }))).toEqual([
      'opened s0',
      'closed s1',
    ]);
  });
});

describe('an event too large to store', () => {
  const result = (content: string) => ({
    type: 'tool_result',
    ...DESCRIBED,
    message: { role: 'tool', toolCallId: 'call_1', content, isError: false },
    durationMs: 3,
  });

  it('is stored as a marker with its type, its seq and its size, and the channel goes on', async () => {
    const made = world();
    const content = 'x'.repeat(100_000);

    publish({ world: made, seq: 4, body: result(content) });
    publish({ world: made, seq: 5, body: toolCall() });

    const entries = await entriesOf({ world: made, channel: made.channel });

    expect(shapeOf(entries)).toEqual(['opened s0', 'event_omitted s1', 'event s2']);
    // What the protocol serves, read back from the store: the marker, and not the event.
    const marker = channelEntrySchema.parse(entries[1]);

    expect(marker).toMatchObject({ type: 'event_omitted', eventType: 'tool_result', seq: 4 });
    expect('size' in marker && marker.size).toBeGreaterThan(100_000);
    expect(entries[1]).not.toHaveProperty('event');
    expect(entries[1]).not.toHaveProperty('content');
    // No failure: the channel took the marker and the entry after it.
    expect(made.failures).toEqual([]);
  });

  it('keeps one that fits just under the limit, whole', async () => {
    const made = world();

    publish({ world: made, seq: 0, body: result('x'.repeat(60_000)) });

    expect(shapeOf(await entriesOf({ world: made, channel: made.channel }))).toEqual([
      'opened s0',
      'event s1',
    ]);
  });

  it.each([
    ['a single delta of tens of thousands of characters', 'x'.repeat(70_000)],
    // JSON writes a control character as six: 12,000 of them are 72,000, whatever the text length.
    ['a delta of control characters that escape to more than the limit', '\u0001'.repeat(12_000)],
  ])('stores %s as a marker too: the text is kept only by the stream', async (_name, text) => {
    const made = world();

    publish({ world: made, seq: 7, body: delta(text) });
    publish({ world: made, seq: 8, body: delta('after') });

    const entries = await entriesOf({ world: made, channel: made.channel });

    expect(shapeOf(entries)).toEqual(['opened s0', 'event_omitted s1', 'event s2']);
    expect(entries[1]).toMatchObject({ eventType: 'text_delta', seq: 7 });
    expect(made.failures).toEqual([]);
  });

  it('breaks only its channel, and tells it once, for an event JSON cannot carry', async () => {
    const made = world();
    const child = startChild(made);
    const own = made.nodeOf(child.id);

    publish({ world: made, seq: 0, body: toolCall() });
    // A tool or a hook left a BigInt in an artifact: nothing JSON can write.
    publish({
      world: made,
      seq: 1,
      body: { ...result('ok'), artifacts: [{ kind: 'k', size: 10n }] },
    });
    publish({ world: made, seq: 2, body: toolCall() });
    publish({ world: made, session: child.id, body: toolCall() });

    // What was told before it is stored; the channel then takes no more, and the run was not troubled.
    expect(shapeOf(await entriesOf({ world: made, channel: made.channel }))).toEqual([
      'opened s0',
      'event s1',
    ]);
    expect(made.failures).toHaveLength(1);
    // Another channel is not touched.
    expect(shapeOf(await entriesOf({ world: made, channel: own }))).toEqual([
      'opened s0',
      'event s1',
    ]);
  });
});

describe('streamed text on an agent’s channel', () => {
  it('is one entry for the deltas of a window: their text in order, the seq of the first, and of the last', async () => {
    const made = world();

    publish({ world: made, seq: 3, body: delta('Hel') });
    publish({ world: made, seq: 4, body: delta('lo, ') });
    publish({ world: made, seq: 5, body: delta('world') });

    // Nothing of the text is stored while its window is open (read from the store, not through a
    // flush of the writer, which would end the window).
    await vi.advanceTimersByTimeAsync(TEXT_DELTA_WINDOW_MS - 1);
    expect(
      shapeOf(await readChannel({ store: made.store, id: conversationId, channel: made.channel })),
    ).toEqual(['opened s0']);

    // The window ends: the timer stores it, with no flush of the writer asked for.
    await vi.advanceTimersByTimeAsync(1);

    const entries = await readChannel({
      store: made.store,
      id: conversationId,
      channel: made.channel,
    });

    expect(shapeOf(entries)).toEqual(['opened s0', 'event s1']);
    expect(entries[1]).toMatchObject({
      event: { seq: 3, type: 'text_delta', text: 'Hello, world' },
      lastSeq: 5,
    });
    expect(channelEntrySchema.safeParse(entries[1]).success).toBe(true);
  });

  it('has no lastSeq for a single delta', async () => {
    const made = world();

    publish({ world: made, seq: 3, body: delta('Hi') });
    await vi.advanceTimersByTimeAsync(TEXT_DELTA_WINDOW_MS);

    const entries = await entriesOf({ world: made, channel: made.channel });

    expect(entries[1]).toMatchObject({ event: { seq: 3, text: 'Hi' } });
    expect(entries[1]).not.toHaveProperty('lastSeq');
  });

  it('starts a new entry for the deltas after the window', async () => {
    const made = world();

    publish({ world: made, seq: 0, body: delta('a') });
    await vi.advanceTimersByTimeAsync(TEXT_DELTA_WINDOW_MS);
    publish({ world: made, seq: 1, body: delta('b') });
    publish({ world: made, seq: 2, body: delta('c') });
    await vi.advanceTimersByTimeAsync(TEXT_DELTA_WINDOW_MS);

    const entries = await entriesOf({ world: made, channel: made.channel });

    expect(shapeOf(entries)).toEqual(['opened s0', 'event s1', 'event s2']);
    expect(entries[2]).toMatchObject({ event: { seq: 1, text: 'bc' }, lastSeq: 2 });
  });

  it('is stored before an event that comes after it, so the order is the order they happened', async () => {
    const made = world();

    publish({ world: made, seq: 0, body: delta('thinking') });
    publish({ world: made, seq: 1, body: toolCall() });

    const { entries, shape } = await stored(made);

    expect(shape).toEqual(['opened s0', 'event s1', 'event s2']);
    expect(entries[1]).toMatchObject({ event: { type: 'text_delta', text: 'thinking' } });
    expect(entries[2]).toMatchObject({ event: { type: 'tool_call_started' } });
  });

  it('is stored before the node’s next update and before its close', async () => {
    const made = world();
    const child = startChild(made);
    const channel = made.nodeOf(child.id);

    publish({ world: made, session: child.id, seq: 0, body: delta('one') });
    made.sessions.report({ id: child.id, status: 'reading' });
    publish({ world: made, session: child.id, seq: 1, body: delta('two') });
    made.sessions.end({ id: child.id, state: 'completed' });

    const entries = await entriesOf({ world: made, channel });

    expect(shapeOf(entries)).toEqual([
      'opened s0',
      'event s1',
      'updated s2',
      'event s3',
      'closed s4',
    ]);
    expect(entries[1]).toMatchObject({ event: { text: 'one' } });
    expect(entries[3]).toMatchObject({ event: { text: 'two' } });
  });

  it('is stored when the writer is flushed, without waiting for the window', async () => {
    const made = world();

    publish({ world: made, seq: 0, body: delta('almost') });

    expect(shapeOf(await entriesOf({ world: made, channel: made.channel }))).toEqual([
      'opened s0',
      'event s1',
    ]);
  });

  it('does not join the deltas of another user message', async () => {
    const made = world();

    made.sessions.setMessage({ sessionId: made.main.id, messageId: FIRST });
    publish({ world: made, seq: 0, body: delta('a') });
    made.sessions.setMessage({ sessionId: made.main.id, messageId: SECOND });
    publish({ world: made, seq: 1, body: delta('b') });

    const { entries, shape } = await stored(made);

    expect(shape).toEqual(['opened s0', 'event s1', 'event s2']);
    expect(entries[1]).toMatchObject({ messageId: FIRST, event: { text: 'a' } });
    expect(entries[2]).toMatchObject({ messageId: SECOND, event: { text: 'b' } });
  });

  it('starts another entry when the text would pass what one may hold, and loses none', async () => {
    const made = world();
    const piece = 'x'.repeat(MAX_MERGED_TEXT_CHARS / 2);

    for (const seq of [0, 1, 2]) publish({ world: made, seq, body: delta(piece) });

    const entries = await entriesOf({ world: made, channel: made.channel });
    const texts = entries.slice(1).map((entry) => (entry.event as { text: string }).text);

    expect(shapeOf(entries)).toEqual(['opened s0', 'event s1', 'event s2']);
    expect(texts.join('')).toBe(piece.repeat(3));
    expect(texts[0]).toHaveLength(MAX_MERGED_TEXT_CHARS);
  });
});

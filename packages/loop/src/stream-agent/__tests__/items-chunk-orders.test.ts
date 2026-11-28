import { describe, expect, it } from 'vitest';
import type { StreamEntry } from '@sheavly/protocol/stream/stream.types';
import { END_TURN, REASONING_CHUNK, TOOL_USE } from '../../testing/item-chunks.constants.js';
import type { ScriptedCall } from '../../testing/item-run.types.js';
import {
  activity,
  completedItems,
  describeItems,
  eventsOf,
  expectItemsBeforeDone,
  expectValidItems,
  gatedCall,
  gatedTool,
  piece,
  runItems,
  scriptedCalls,
  splitToolEnds,
} from '../../testing/items.fake.js';

/** Runs `calls` with a tool whose calls `c1` to `c3` return at once. */
async function run(calls: ScriptedCall[], options: { listen?: boolean } = {}) {
  const gated = gatedTool(['c1', 'c2', 'c3']);

  for (const id of ['c1', 'c2', 'c3']) gated.open(id);

  return runItems({ provider: scriptedCalls(calls), tools: [gated.tool], ...options });
}

/** `seq kind:type` for an entry of the combined stream, as far as the type is the entry's. */
function describeEntry(entry: StreamEntry): string {
  if (entry.kind === 'event') return `${String(entry.seq)} event:${entry.event.type}`;

  if (entry.kind === 'update') return `${String(entry.seq)} update:${entry.update.type}`;

  return `${String(entry.seq)} ${entry.kind}`;
}

describe('the items of a reply, for each order of chunks a provider sends', () => {
  it('(a) text only: one message, a delta for each chunk, completed when the call ends', async () => {
    const result = await run([{ chunks: [piece('Hel'), piece('lo'), END_TURN] }]);

    expect(describeItems(eventsOf(result.items))).toEqual([
      'start message1',
      'message1 @0 "Hel"',
      'message1 @3 "lo"',
      'end message1 completed "Hello"',
    ]);
    expect(result.items.map((item) => item.sessionId)).toEqual(
      result.items.map(() => result.sessions.list()[0]?.id),
    );
  });

  it('(b) text, a tool call, text: two messages around a tool item, and a third in the next call', async () => {
    const result = await run([
      { chunks: [piece('Let me look.'), gatedCall('c1'), piece(' Reading.'), TOOL_USE] },
      { chunks: [piece('Done.'), END_TURN] },
    ]);
    const { toolEnds, rest } = splitToolEnds(describeItems(eventsOf(result.items)));

    expect(rest).toEqual([
      'start message1',
      'message1 @0 "Let me look."',
      'end message1 completed "Let me look."',
      'start tool_call1 gated',
      'start message2',
      'message2 @0 " Reading."',
      'end message2 completed " Reading."',
      'start message3',
      'message3 @0 "Done."',
      'end message3 completed "Done."',
    ]);
    expect(toolEnds).toEqual(['end tool_call1 completed']);
    expect(completedItems(eventsOf(result.items))).toContainEqual(
      expect.objectContaining({ kind: 'tool_call', turn: 1, callId: 'c1' }),
    );
  });

  it('(c) the Messages order, reasoning last: the first message completes at the tool call and the reasoning item is the last of the reply', async () => {
    const result = await run([
      {
        chunks: [
          activity(true),
          piece('Let me'),
          gatedCall('c1'),
          piece(' go'),
          REASONING_CHUNK,
          TOOL_USE,
        ],
      },
      { chunks: [END_TURN] },
    ]);
    const { rest } = splitToolEnds(describeItems(eventsOf(result.items)));

    expect(rest).toEqual([
      'start message1',
      'message1 @0 "Let me"',
      'end message1 completed "Let me"',
      'start tool_call1 gated',
      'start message2',
      'message2 @0 " go"',
      'end message2 completed " go"',
      'start reasoning1',
      'end reasoning1 completed',
    ]);
  });

  it('(d) the chat-completions order: reasoning activity inside the text does not split it, and the reasoning completes it before the tool calls', async () => {
    const result = await run([
      {
        chunks: [
          piece('I will '),
          activity(true),
          piece('read'),
          activity(false),
          REASONING_CHUNK,
          gatedCall('c1'),
          gatedCall('c2'),
          TOOL_USE,
        ],
      },
      { chunks: [END_TURN] },
    ]);
    const { toolEnds, rest } = splitToolEnds(describeItems(eventsOf(result.items)));

    expect(rest).toEqual([
      'start message1',
      'message1 @0 "I will "',
      'message1 @7 "read"',
      'end message1 completed "I will read"',
      'start reasoning1',
      'end reasoning1 completed',
      'start tool_call1 gated',
      'start tool_call2 gated',
    ]);
    expect([...toolEnds].sort()).toEqual(['end tool_call1 completed', 'end tool_call2 completed']);
  });

  it('a reply with no text makes no message, and a reply of reasoning alone makes one reasoning item', async () => {
    const result = await run([{ chunks: [REASONING_CHUNK, END_TURN] }]);

    expect(describeItems(eventsOf(result.items))).toEqual([
      'start reasoning1',
      'end reasoning1 completed',
    ]);
  });

  it('(j) tells every item before the run’s done reaches its consumer', async () => {
    const result = await run([
      { chunks: [piece('a'), gatedCall('c1'), TOOL_USE] },
      { chunks: [piece('b'), END_TURN] },
    ]);

    expectItemsBeforeDone(result);
    expect(result.log.at(-1)).toBe('event:done');
  });

  it('(m) every completed item parses as an item and every event as an item event', async () => {
    const result = await run([
      {
        chunks: [
          piece('a'),
          REASONING_CHUNK,
          gatedCall('c1'),
          gatedCall('c2'),
          piece('b'),
          TOOL_USE,
        ],
      },
      { chunks: [piece('c'.repeat(9_000)), END_TURN] },
    ]);

    expect(completedItems(eventsOf(result.items)).map((item) => item.kind)).toEqual(
      expect.arrayContaining(['message', 'reasoning', 'tool_call']),
    );
    expectValidItems(eventsOf(result.items));
  });

  it('(l) puts no item in the combined stream or the run’s events: a run with a listener and one without have the same of both', async () => {
    const calls = (): ScriptedCall[] => [
      { chunks: [piece('Let me look.'), REASONING_CHUNK, gatedCall('c1'), TOOL_USE] },
      { chunks: [piece('Done.'), END_TURN] },
    ];
    const heard = await run(calls());
    const unheard = await run(calls(), { listen: false });
    const eventsSeen = (events: typeof heard.events) =>
      events.map((event) => `${String(event.seq)} ${event.type}`);
    const entriesSeen = (entries: typeof heard.entries) => entries.map(describeEntry);

    expect(heard.items.length).toBeGreaterThan(0);
    expect(unheard.items).toEqual([]);
    expect(eventsSeen(heard.events)).toEqual(eventsSeen(unheard.events));
    expect(entriesSeen(heard.entries)).toEqual(entriesSeen(unheard.entries));
    expect(entriesSeen(heard.entries).filter((line) => line.includes('item_'))).toEqual([]);
    expect(eventsSeen(heard.events).filter((line) => line.includes('item_'))).toEqual([]);
  });
});

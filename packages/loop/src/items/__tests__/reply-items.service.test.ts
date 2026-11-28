import { describe, expect, it } from 'vitest';
import { MAX_OMITTED_CALL_CHARS } from '@sheavly/protocol/channel/channel.constants';
import {
  MAX_ITEM_DESCRIPTION_CHARS,
  MAX_ITEM_TEXT_CHARS,
} from '@sheavly/protocol/item/item.constants';
import type { ItemEvent } from '@sheavly/protocol/item/item.types';
import type { ToolCall, ToolMessage } from '@sheavly/protocol/message/message.types';
import { callIdSchema } from '@sheavly/protocol/message/message.validator';
import { completedItems, describeItems, expectValidItems } from '../../testing/items.fake.js';
import { ReplyItems } from '../reply-items.service.js';

const PAIR = '\u{1F600}';
const HIGH = PAIR.charAt(0);
const LOW = PAIR.charAt(1);
const REASONING = { source: 'test:model', data: { opaque: 'state' } };

/** A reply being made on the third model call of a run, and every event it told. */
function reply() {
  const events: ItemEvent[] = [];
  const items = new ReplyItems({ publish: (event) => events.push(event), turn: 3 });

  return { items, events };
}

const toolCall = (id: string, name = 'read_file'): ToolCall => ({
  id: callIdSchema.parse(id),
  name,
  input: { description: 'reading', path: 'a.ts' },
});

const settled: ToolMessage = {
  role: 'tool',
  toolCallId: callIdSchema.parse('c1'),
  content: 'file text',
  isError: false,
  at: 1,
};

/** The text each message item completed with, in order. */
const messageTexts = (events: ItemEvent[]) =>
  completedItems(events).flatMap((item) => (item.kind === 'message' ? [item.text] : []));

/** The deltas of a reply: text and where it starts. */
const deltasOf = (events: ItemEvent[]) =>
  events.flatMap((event) => (event.type === 'item_delta' ? [event] : []));

describe('a message item', () => {
  it('starts with the first text and grows by a delta for each chunk, at the offset it had', () => {
    const { items, events } = reply();

    items.text('Hel');
    items.text('lo');
    items.finish({ reason: 'completed' });

    expect(describeItems(events)).toEqual([
      'start message1',
      'message1 @0 "Hel"',
      'message1 @3 "lo"',
      'end message1 completed "Hello"',
    ]);
    expectValidItems(events);
  });

  it('is not started by an empty chunk, and a reply with no text makes no message', () => {
    const { items, events } = reply();

    items.text('');
    items.finish({ reason: 'completed' });

    expect(events).toEqual([]);
  });

  it('completes with the reason the model call ended with, partial text kept', () => {
    const { items, events } = reply();

    items.text('half a sen');
    items.finish({ reason: 'interrupted' });

    expect(describeItems(events).at(-1)).toBe('end message1 interrupted "half a sen"');
  });

  it('splits a chunk that passes the cap: what fits is a delta, the message completes, the rest starts another', () => {
    const { items, events } = reply();

    items.text('a'.repeat(MAX_ITEM_TEXT_CHARS - 2));
    items.text('bcdef');
    items.finish({ reason: 'completed' });

    expect(describeItems(events)).toEqual([
      'start message1',
      `message1 @0 ${JSON.stringify('a'.repeat(MAX_ITEM_TEXT_CHARS - 2))}`,
      'message1 @8190 "bc"',
      `end message1 completed ${JSON.stringify(`${'a'.repeat(MAX_ITEM_TEXT_CHARS - 2)}bc`)}`,
      'start message2',
      'message2 @0 "def"',
      'end message2 completed "def"',
    ]);
    expectValidItems(events);
  });

  it('splits a long chunk into as many messages as it needs, with offsets that add up', () => {
    const { items, events } = reply();
    const text = 'x'.repeat(MAX_ITEM_TEXT_CHARS * 2 + 10);

    items.text(text);
    items.finish({ reason: 'completed' });

    const texts = messageTexts(events);

    expect(texts.map((part) => part.length)).toEqual([
      MAX_ITEM_TEXT_CHARS,
      MAX_ITEM_TEXT_CHARS,
      10,
    ]);
    expect(texts.join('')).toBe(text);
    expect(deltasOf(events).map(({ offset, text: delta }) => [offset, delta.length])).toEqual([
      [0, MAX_ITEM_TEXT_CHARS],
      [0, MAX_ITEM_TEXT_CHARS],
      [0, 10],
    ]);
    expectValidItems(events);
  });

  it('keeps a message that fills the cap exactly open until more text comes', () => {
    const { items, events } = reply();

    items.text('a'.repeat(MAX_ITEM_TEXT_CHARS));

    expect(events.map((event) => event.type)).toEqual(['item_started', 'item_delta']);

    items.text('b');

    expect(describeItems(events).slice(2)).toEqual([
      expect.stringMatching(/^end message1 completed/),
      'start message2',
      'message2 @0 "b"',
    ]);
  });

  it('never cuts inside a surrogate pair at the cap: the pair moves to the next message', () => {
    const { items, events } = reply();

    items.text(`${'a'.repeat(MAX_ITEM_TEXT_CHARS - 1)}${PAIR}z`);
    items.finish({ reason: 'completed' });

    const texts = messageTexts(events);

    expect(texts).toEqual(['a'.repeat(MAX_ITEM_TEXT_CHARS - 1), `${PAIR}z`]);
    expect(deltasOf(events).every((delta) => delta.text.isWellFormed())).toBe(true);
    expectValidItems(events);
  });

  it('holds back a high surrogate that ends a chunk and sends the pair whole with the next', () => {
    const { items, events } = reply();

    items.text(`ab${HIGH}`);
    items.text(`${LOW}cd`);
    items.finish({ reason: 'completed' });

    expect(describeItems(events)).toEqual([
      'start message1',
      'message1 @0 "ab"',
      `message1 @2 ${JSON.stringify(`${PAIR}cd`)}`,
      `end message1 completed ${JSON.stringify(`ab${PAIR}cd`)}`,
    ]);
    expectValidItems(events);
  });

  it('turns a high surrogate still alone when the message completes into U+FFFD', () => {
    const { items, events } = reply();

    items.text(`ab${HIGH}`);
    items.finish({ reason: 'completed' });

    expect(messageTexts(events)).toEqual(['ab\uFFFD']);
    expect(deltasOf(events).map(({ offset, text }) => [offset, text])).toEqual([
      [0, 'ab'],
      [2, '\uFFFD'],
    ]);
    expectValidItems(events);
  });

  it('makes a message of a lone unit that was the whole reply', () => {
    const { items, events } = reply();

    items.text(HIGH);
    items.finish({ reason: 'completed' });

    expect(messageTexts(events)).toEqual(['\uFFFD']);
  });

  it('replaces a lone unit inside a chunk by one unit, so the offsets still add up', () => {
    const { items, events } = reply();

    items.text(`a${LOW}b`);
    items.text('c');
    items.finish({ reason: 'completed' });

    expect(deltasOf(events).map(({ offset, text }) => [offset, text])).toEqual([
      [0, 'a\uFFFDb'],
      [3, 'c'],
    ]);
    expectValidItems(events);
  });
});

describe('a content chunk after text', () => {
  it('completes the open message when the model calls a tool', () => {
    const { items, events } = reply();

    items.text('Let me look.');
    items.toolCall({ call: toolCall('c1'), description: 'reading a.ts' });

    expect(describeItems(events)).toEqual([
      'start message1',
      'message1 @0 "Let me look."',
      'end message1 completed "Let me look."',
      'start tool_call1 read_file',
    ]);
  });

  it('completes the open message when reasoning arrives, and text after it is a new message', () => {
    const { items, events } = reply();

    items.text('one');
    items.reasoning(REASONING);
    items.text('two');
    items.finish({ reason: 'completed' });

    expect(describeItems(events)).toEqual([
      'start message1',
      'message1 @0 "one"',
      'end message1 completed "one"',
      'start reasoning1',
      'end reasoning1 completed',
      'start message2',
      'message2 @0 "two"',
      'end message2 completed "two"',
    ]);
  });
});

describe('a reasoning item', () => {
  it('is born whole: started and completed at once, holding what the model needs resent', () => {
    const { items, events } = reply();

    items.reasoning(REASONING);

    expect(describeItems(events)).toEqual(['start reasoning1', 'end reasoning1 completed']);
    expect(completedItems(events)).toMatchObject([
      { kind: 'reasoning', item: REASONING, reason: 'completed' },
    ]);
    expectValidItems(events);
  });
});

describe('a tool call item', () => {
  it('starts with its header, never its input, and says the model call it came from', () => {
    const { items, events } = reply();
    const id = items.toolCall({ call: toolCall('c1'), description: 'reading a.ts' });

    expect(events).toEqual([
      {
        type: 'item_started',
        itemId: id,
        kind: 'tool_call',
        name: 'read_file',
        callId: 'c1',
        description: 'reading a.ts',
        turn: 3,
      },
    ]);
    expectValidItems(events);
  });

  it('cuts a long name and description at a code point, to the bounds of the schema', () => {
    const { items, events } = reply();
    const name = `${'n'.repeat(MAX_OMITTED_CALL_CHARS - 1)}${PAIR}tail`;
    const description = `${'d'.repeat(MAX_ITEM_DESCRIPTION_CHARS - 1)}${PAIR}tail`;

    items.toolCall({ call: toolCall('c1', name), description });

    const [started] = events;

    expect(started).toMatchObject({
      name: 'n'.repeat(MAX_OMITTED_CALL_CHARS - 1),
      description: 'd'.repeat(MAX_ITEM_DESCRIPTION_CHARS - 1),
    });
    expectValidItems(events);
  });

  it.each([
    ['one over the bound', 'c'.repeat(MAX_OMITTED_CALL_CHARS + 1)],
    ['empty', ''],
  ])('leaves the provider’s call id out, never cutting it, when it is %s', (_name, id) => {
    const { items, events } = reply();

    items.toolCall({ call: toolCall(id), description: 'x' });

    expect(events[0]).not.toHaveProperty('callId');
    expectValidItems(events);
  });

  it('keeps a call id of exactly the bound', () => {
    const { items, events } = reply();
    const id = 'c'.repeat(MAX_OMITTED_CALL_CHARS);

    items.toolCall({ call: toolCall(id), description: 'x' });

    expect(events[0]).toMatchObject({ callId: id });
    expectValidItems(events);
  });

  it('completes later with its input and result, after the model call has finished', () => {
    const { items, events } = reply();
    const id = items.toolCall({ call: toolCall('c1'), description: 'reading a.ts' });

    items.finish({ reason: 'completed' });
    items.completeTool({
      id,
      described: { call: toolCall('c1'), description: 'reading a.ts' },
      outcome: {
        type: 'tool_result',
        call: toolCall('c1'),
        description: 'reading a.ts',
        message: settled,
        durationMs: 12,
      },
      message: settled,
      reason: 'completed',
    });

    expect(completedItems(events)).toEqual([
      {
        kind: 'tool_call',
        id,
        callId: 'c1',
        name: 'read_file',
        description: 'reading a.ts',
        turn: 3,
        input: { description: 'reading', path: 'a.ts' },
        result: { content: 'file text', isError: false, durationMs: 12 },
        reason: 'completed',
      },
    ]);
    expectValidItems(events);
  });
});

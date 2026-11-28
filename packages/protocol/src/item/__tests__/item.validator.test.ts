import { describe, expect, it } from 'vitest';
import { MAX_OMITTED_CALL_CHARS } from '../../channel/channel.constants.js';
import { agentEventSchema, entryEventSchema } from '../../event/event.validator.js';
import { streamEntrySchema } from '../../stream/stream.validator.js';
import { MAX_ITEM_DESCRIPTION_CHARS, MAX_ITEM_TEXT_CHARS } from '../item.constants.js';
import type { Item, ItemEvent, ItemId } from '../item.types.js';
import {
  itemDeltaEventSchema,
  itemEventSchema,
  itemIdSchema,
  itemSchema,
  itemStartedEventSchema,
} from '../item.validator.js';

const ITEM_ID = '3f1b2c4d-5e6f-4a7b-8c9d-0e1f2a3b4c5d';

const message = (more: object = {}) => ({
  kind: 'message',
  id: ITEM_ID,
  text: 'Done.',
  reason: 'completed',
  ...more,
});

/** An interrupted tool call: no result, which is all an item has of a tool that never settled. */
const toolCall = (more: object = {}) => ({
  kind: 'tool_call',
  id: ITEM_ID,
  callId: 'call_0',
  name: 'read_file',
  description: 'reading index.ts',
  turn: 0,
  input: { path: 'index.ts' },
  reason: 'interrupted',
  ...more,
});

const result = { content: 'hello', isError: false, durationMs: 12 };
const task = {
  info: {
    id: 't1',
    command: 'npm test',
    description: 'tests',
    kind: 'task',
    status: 'running',
    startedAt: 1,
    output: '',
  },
  nodeId: 'task-1',
  durationMs: 4,
};

const isItem = (value: unknown) => itemSchema.safeParse(value).success;
const isEvent = (value: unknown) => itemEventSchema.safeParse(value).success;

describe('an item’s id', () => {
  it('is typed as an item’s, and parses to what was given', () => {
    const id: ItemId = itemIdSchema.parse(ITEM_ID);
    const item: Item = itemSchema.parse(message({ id }));
    const event: ItemEvent = itemEventSchema.parse({ type: 'item_completed', item });

    expect(event).toEqual({ type: 'item_completed', item: message() });
  });

  it('is a lowercase UUID, which no provider’s id is', () => {
    expect(itemIdSchema.safeParse(ITEM_ID).success).toBe(true);
    expect(itemIdSchema.safeParse(ITEM_ID.toUpperCase()).success).toBe(false);
    expect(itemIdSchema.safeParse('call_0').success).toBe(false);
  });
});

describe('a message item', () => {
  it('holds a reply’s text and how it ended', () => {
    expect(isItem(message())).toBe(true);
    expect(isItem(message({ reason: 'interrupted' }))).toBe(true);
    expect(isItem(message({ reason: 'failed', text: '' }))).toBe(true);
  });

  it('holds at most MAX_ITEM_TEXT_CHARS UTF-16 code units', () => {
    expect(isItem(message({ text: 'x'.repeat(MAX_ITEM_TEXT_CHARS) }))).toBe(true);
    expect(isItem(message({ text: 'x'.repeat(MAX_ITEM_TEXT_CHARS + 1) }))).toBe(false);
  });

  it('counts a character outside the basic plane as two units, and never holds half of one', () => {
    const wholePair = `${'x'.repeat(MAX_ITEM_TEXT_CHARS - 2)}😀`;

    expect(isItem(message({ text: wholePair }))).toBe(true);
    expect(isItem(message({ text: `${wholePair}x` }))).toBe(false);
    expect(isItem(message({ text: 'ends in half a pair \ud83d' }))).toBe(false);
  });

  it.each([
    ['a reason it does not have', message({ reason: 'cancelled' })],
    ['no reason', message({ reason: undefined })],
    ['an id that is not an item’s', message({ id: 'call_0' })],
    ['a kind it does not have', message({ kind: 'image' })],
  ])('is not %s', (_name, value) => {
    expect(isItem(value)).toBe(false);
  });
});

describe('a reasoning item', () => {
  const reasoning = (more: object = {}) => ({
    kind: 'reasoning',
    id: ITEM_ID,
    reason: 'completed',
    ...more,
  });

  it('holds the replay state, or says how large the state was when it was left out', () => {
    expect(isItem(reasoning({ item: { source: 'responses', data: { blob: 1 } } }))).toBe(true);
    expect(isItem(reasoning({ omitted: 70_000 }))).toBe(true);
  });

  it('does not hold the state it says it left out', () => {
    const state = { source: 'responses', data: { blob: 1 } };

    expect(isItem(reasoning({ item: state, omitted: 70_000 }))).toBe(false);
  });

  it('is not an omitted state of no size', () => {
    expect(isItem(reasoning({ omitted: 0 }))).toBe(false);
    expect(isItem(reasoning({ omitted: 1.5 }))).toBe(false);
  });
});

describe('a tool call item', () => {
  it('holds the call, and for a tool that never settled nothing but how it ended', () => {
    const { callId: _callId, ...withoutCallId } = toolCall({ reason: 'failed' });

    expect(isItem(toolCall())).toBe(true);
    expect(isItem(withoutCallId)).toBe(true);
  });

  it('holds what the tool returned, as a tool_result event carries it', () => {
    const artifacts = [{ kind: 'file_read', path: 'index.ts' }];

    expect(isItem(toolCall({ reason: 'completed', result }))).toBe(true);
    expect(isItem(toolCall({ reason: 'completed', result: { ...result, artifacts } }))).toBe(true);
    expect(isItem(toolCall({ reason: 'completed', result: { content: 'x' } }))).toBe(false);
  });

  it('holds the task and the node a call launched, as a task_running event carries them', () => {
    expect(isItem(toolCall({ reason: 'completed', task }))).toBe(true);
    expect(isItem(toolCall({ task: { ...task, nodeId: undefined } }))).toBe(false);
  });

  it('is never both a result and a launched task', () => {
    expect(isItem(toolCall({ result, task }))).toBe(false);
  });

  it('may leave out the input or the result that was too large, saying how large each was', () => {
    const { input: _input, ...withoutInput } = toolCall({ omitted: { input: 90_000 } });

    expect(isItem(withoutInput)).toBe(true);
    expect(isItem(toolCall({ omitted: { result: 90_000 } }))).toBe(true);
    expect(isItem(toolCall({ omitted: { result: 0 } }))).toBe(false);
  });

  it('does not hold an input or a result it says it left out', () => {
    expect(isItem(toolCall({ omitted: { input: 90_000 } }))).toBe(false);
    expect(isItem(toolCall({ result, omitted: { result: 90_000 } }))).toBe(false);
    expect(isItem(toolCall({ result, omitted: { input: 90_000 } }))).toBe(false);
  });

  it.each([
    ['name', 'name', MAX_OMITTED_CALL_CHARS],
    ['call id', 'callId', MAX_OMITTED_CALL_CHARS],
    ['description', 'description', MAX_ITEM_DESCRIPTION_CHARS],
  ])('holds a %s of at most its bound, which a hostile provider cannot exceed', (_n, key, max) => {
    expect(isItem(toolCall({ [key]: 'x'.repeat(max) }))).toBe(true);
    expect(isItem(toolCall({ [key]: 'x'.repeat(max + 1) }))).toBe(false);
  });

  it('takes no empty call id: a call id that is not usable is left out', () => {
    expect(isItem(toolCall({ callId: '' }))).toBe(false);
  });

  it.each([
    ['a turn that is not a whole number', toolCall({ turn: 1.5 })],
    ['a negative turn', toolCall({ turn: -1 })],
    ['no name', toolCall({ name: undefined })],
    ['no turn', toolCall({ turn: undefined })],
  ])('is not %s', (_name, value) => {
    expect(isItem(value)).toBe(false);
  });
});

describe('what an item says as it happens', () => {
  it('starts a message or a reasoning with its id and kind', () => {
    expect(isEvent({ type: 'item_started', itemId: ITEM_ID, kind: 'message' })).toBe(true);
    expect(isEvent({ type: 'item_started', itemId: ITEM_ID, kind: 'reasoning' })).toBe(true);
  });

  it('starts a tool call with its header, and never carries its input', () => {
    const started = {
      type: 'item_started',
      itemId: ITEM_ID,
      kind: 'tool_call',
      name: 'read_file',
      callId: 'call_0',
      turn: 2,
      description: 'reading index.ts',
    };
    const parsed = itemStartedEventSchema.parse({ ...started, input: { path: '/etc/passwd' } });

    expect(parsed).toEqual(started);
    expect(isEvent({ ...started, description: 'x'.repeat(MAX_ITEM_DESCRIPTION_CHARS + 1) })).toBe(
      false,
    );
    expect(isEvent({ ...started, name: 'x'.repeat(MAX_OMITTED_CALL_CHARS + 1) })).toBe(false);
    expect(isEvent({ ...started, turn: undefined })).toBe(false);
  });

  it('grows a message by a delta at an offset of UTF-16 code units', () => {
    const delta = { type: 'item_delta', itemId: ITEM_ID, offset: 0, text: 'He' };

    expect(itemDeltaEventSchema.safeParse(delta).success).toBe(true);
    expect(isEvent({ ...delta, offset: 4_096 })).toBe(true);
    expect(isEvent({ ...delta, offset: -1 })).toBe(false);
    expect(isEvent({ ...delta, offset: 1.5 })).toBe(false);
    expect(isEvent({ ...delta, offset: undefined })).toBe(false);
  });

  it('ends a delta inside what a message may hold, so no offset can be a huge one', () => {
    const delta = { type: 'item_delta', itemId: ITEM_ID, text: 'He' };

    expect(isEvent({ ...delta, offset: MAX_ITEM_TEXT_CHARS - 2 })).toBe(true);
    expect(isEvent({ ...delta, offset: MAX_ITEM_TEXT_CHARS - 1 })).toBe(false);
    expect(isEvent({ ...delta, text: '', offset: MAX_ITEM_TEXT_CHARS })).toBe(true);
    expect(isEvent({ ...delta, text: '', offset: MAX_ITEM_TEXT_CHARS + 1 })).toBe(false);
    expect(isEvent({ ...delta, text: '', offset: Number.MAX_SAFE_INTEGER })).toBe(false);
  });

  it('bounds a delta’s text as a message’s, and never cuts a pair', () => {
    const delta = { type: 'item_delta', itemId: ITEM_ID, offset: 0 };

    expect(isEvent({ ...delta, text: 'x'.repeat(MAX_ITEM_TEXT_CHARS) })).toBe(true);
    expect(isEvent({ ...delta, text: 'x'.repeat(MAX_ITEM_TEXT_CHARS + 1) })).toBe(false);
    expect(isEvent({ ...delta, text: '\ude00 starts in half a pair' })).toBe(false);
  });

  it('completes with the item', () => {
    expect(isEvent({ type: 'item_completed', item: message() })).toBe(true);
    expect(isEvent({ type: 'item_completed', item: toolCall() })).toBe(true);
    expect(isEvent({ type: 'item_completed' })).toBe(false);
  });

  it.each([
    { type: 'item_started', itemId: ITEM_ID, kind: 'message' },
    { type: 'item_delta', itemId: ITEM_ID, offset: 0, text: 'He' },
    { type: 'item_completed', item: message() },
  ])('is not an event of the loop or an entry of the combined stream: $type', (event) => {
    expect(entryEventSchema.safeParse({ seq: 0, ...event }).success).toBe(false);
    expect(agentEventSchema.safeParse({ seq: 0, ...event }).success).toBe(false);
    expect(
      streamEntrySchema.safeParse({
        seq: 0,
        sessionId: 'session-1',
        at: 1,
        kind: 'event',
        event: { seq: 0, ...event },
      }).success,
    ).toBe(false);
  });
});

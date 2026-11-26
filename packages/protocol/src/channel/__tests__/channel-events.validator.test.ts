import { describe, expect, it } from 'vitest';
import { agentEventBodySchema } from '../../event/event.validator.js';
import { TREE_ONLY_EVENT_TYPES } from '../channel.constants.js';
import { channelEntrySchema } from '../channel.validator.js';

const MESSAGE = '3f1b2c4d-5e6f-4a7b-8c9d-0e1f2a3b4c5d';
const CALL = {
  call: { id: 'call-1', name: 'read_file', input: { path: 'a.ts' } },
  description: 'reading a.ts',
};
const SESSION = { id: 'main', rootId: 'main', depth: 1 };

/** An `event` entry of agent-1's channel, wrapping `event`. */
const eventEntry = (event: object, more: object = {}) => ({
  channel: 'agent-1',
  cursor: 's3',
  at: 5,
  type: 'event',
  event,
  ...more,
});

/** An `event_omitted` entry of agent-1's channel. */
const omitted = (more: object = {}) => ({
  channel: 'agent-1',
  cursor: 's4',
  at: 5,
  type: 'event_omitted',
  eventType: 'tool_result',
  seq: 12,
  size: 90_000,
  ...more,
});

const served = (value: unknown) => channelEntrySchema.safeParse(value).success;

describe('an agent’s loop event on its channel', () => {
  it.each([
    ['a text delta', { seq: 4, type: 'text_delta', text: 'hello' }],
    [
      'a tool result',
      {
        seq: 9,
        type: 'tool_result',
        ...CALL,
        message: { role: 'tool', toolCallId: 'call-1', content: 'ok', isError: false },
        durationMs: 3,
      },
    ],
    ['a usage report', { seq: 10, type: 'usage', usage: { tokens: null } }],
    [
      'the run’s end, with no history',
      { seq: 11, type: 'done', reason: 'completed', session: SESSION },
    ],
  ])('wraps %s as the stream carried it', (_name, event) => {
    expect(served(eventEntry(event))).toBe(true);
  });

  it('keeps the originating message of the stream’s entry, when it had one', () => {
    const delta = { seq: 4, type: 'text_delta', text: 'hello' };

    expect(served(eventEntry(delta, { messageId: MESSAGE }))).toBe(true);
    expect(served(eventEntry(delta, { messageId: 'not-a-message-id' }))).toBe(false);
  });

  it('comes after the opened entry, in a numbered channel', () => {
    const delta = { seq: 4, type: 'text_delta', text: 'hello' };

    expect(served(eventEntry(delta, { cursor: 's1' }))).toBe(true);
    expect(served(eventEntry(delta, { cursor: 's0' }))).toBe(false);
    expect(served(eventEntry(delta, { cursor: 'b5' }))).toBe(false);
  });

  it.each([
    ['not an event', { seq: 1, type: 'nothing_like_it' }],
    ['an event with no seq', { type: 'text_delta', text: 'hello' }],
    [
      'an event of a conversation notice: a storage failure',
      { seq: 0, type: 'storage_failed', error: 'disk full' },
    ],
    [
      'an event of a conversation notice: an extension’s own',
      {
        seq: 0,
        type: 'extension_event',
        extension: 'acme',
        kind: 'acme.done',
        version: 1,
        data: {},
        text: 'Done',
      },
    ],
  ])('refuses %s', (_name, event) => {
    expect(served(eventEntry(event))).toBe(false);
  });

  describe('a text delta that merges the ones after it', () => {
    const delta = { seq: 4, type: 'text_delta', text: 'hello, world' };

    it('says the seq of the last delta it holds, after its own', () => {
      expect(served(eventEntry(delta, { lastSeq: 7 }))).toBe(true);
    });

    it.each([
      ['the same seq as its own', 4],
      ['a seq before its own', 2],
      ['a seq that is not a whole number', 5.5],
    ])('refuses %s', (_name, lastSeq) => {
      expect(served(eventEntry(delta, { lastSeq }))).toBe(false);
    });

    it('is only a text delta: no other event is merged', () => {
      const batch = { seq: 4, type: 'turn_end', turn: 1, stopReason: 'interrupted' };

      expect(served(eventEntry(batch, { lastSeq: 7 }))).toBe(false);
    });
  });
});

describe('what stands in an agent’s channel for an event too large to store', () => {
  it('says which event it was, where it stood in the session’s stream and how large it was', () => {
    expect(served(omitted())).toBe(true);
    expect(served(omitted({ messageId: MESSAGE }))).toBe(true);
  });

  it('may name an event type a reader does not know', () => {
    expect(served(omitted({ eventType: 'a_later_event' }))).toBe(true);
  });

  it.each([
    ['no event type', omitted({ eventType: '' })],
    ['an event type over its cap', omitted({ eventType: 'x'.repeat(129) })],
    ['a seq that is not a whole number', omitted({ seq: 1.5 })],
    ['a negative seq', omitted({ seq: -1 })],
    ['a size of nothing: an event that was never there', omitted({ size: 0 })],
    ['a size that is not a whole number', omitted({ size: 10.5 })],
    ['the first cursor, which is the opened entry’s', omitted({ cursor: 's0' })],
    ['a byte cursor', omitted({ cursor: 'b9' })],
  ])('refuses %s', (_name, value) => {
    expect(served(value)).toBe(false);
  });
});

/**
 * Every loop event that is an agent’s: the events the mapping (`wire-model-mapping.md`) puts on the
 * agent channel of the session that produced them. Adding a loop event means deciding here whether
 * it is one, or a conversation notice (`TREE_ONLY_EVENT_TYPES`).
 */
const AGENT_EVENT_TYPES = [
  'run_failed',
  'usage',
  'harness_notice',
  'text_delta',
  'reasoning',
  'reasoning_activity',
  'model_connection',
  'tool_call_started',
  'turn_end',
  'tool_batch',
  'tool_result',
  'task_running',
  'task_completed',
  'message_received',
  'run_state',
  'context_added',
  'model_input_changed',
  'summary_started',
  'summary_done',
  'summary_failed',
  'hook_failed',
  'done',
];

describe('every loop event', () => {
  const eventTypes = agentEventBodySchema.options.map((option) => option.shape.type.value);

  it('is decided: an agent’s, or a conversation notice, and a new one fails here until it is', () => {
    expect([...eventTypes].sort()).toEqual([...AGENT_EVENT_TYPES, ...TREE_ONLY_EVENT_TYPES].sort());
  });

  it('leaves 22 of the 24 on an agent’s channel, as the mapping says', () => {
    expect(eventTypes).toHaveLength(24);
    expect(AGENT_EVENT_TYPES).toHaveLength(22);
    expect(TREE_ONLY_EVENT_TYPES).toHaveLength(2);
  });
});

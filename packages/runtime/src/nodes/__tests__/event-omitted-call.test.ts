import { describe, expect, it } from 'vitest';
import {
  MAX_CHANNEL_ENTRY_CHARS,
  MAX_OMITTED_CALL_CHARS,
} from '@sheavly/protocol/channel/channel.constants';
import { channelEntrySchema } from '@sheavly/protocol/channel/channel.validator';
import { entryEventSchema } from '@sheavly/protocol/event/event.validator';
import { eventEntry } from '../node-channel-entries.utils.js';

const HUGE = 'x'.repeat(100_000);

/** A described call whose id and tool name are `id` and `name`. */
const described = (params: { id?: string; name?: string } = {}) => ({
  call: { id: params.id ?? 'call_1', name: params.name ?? 'read_file', input: { path: 'a.ts' } },
  description: 'reading a.ts',
});

const toolMessage = (id: string) => ({
  role: 'tool',
  toolCallId: id,
  content: HUGE,
  isError: false,
});

/** The events that carry one call, each too large to store, built for a call with `params`. */
const callEvents = (params: { id?: string; name?: string } = {}) => ({
  tool_call_started: {
    type: 'tool_call_started',
    ...described({ ...params }),
    description: HUGE,
  },
  tool_result: {
    type: 'tool_result',
    ...described({ ...params }),
    message: toolMessage(params.id ?? 'call_1'),
    durationMs: 3,
  },
  task_running: {
    type: 'task_running',
    ...described({ ...params }),
    task: {
      id: 'task_1',
      command: 'sleep 1',
      description: 'waiting',
      kind: 'task',
      status: 'running',
      startedAt: 1,
      output: '',
    },
    message: toolMessage(params.id ?? 'call_1'),
    durationMs: 3,
  },
});

/** What the channel holds for `body` when it does not fit an entry, as the protocol serves it. */
function storedStub(body: object) {
  const event = entryEventSchema.parse({ seq: 6, ...body });
  const entry = eventEntry({ channel: 'agent-1', cursor: 's4', at: 5, event });

  expect(entry.type).toBe('event_omitted');

  return { entry, served: channelEntrySchema.parse(entry) };
}

describe('the entry of an event too large to store', () => {
  it.each(Object.entries(callEvents()))(
    'keeps the call of a %s: its id and its tool name',
    (type, body) => {
      const { entry, served } = storedStub(body);

      expect(entry).toMatchObject({
        eventType: type,
        seq: 6,
        call: { id: 'call_1', name: 'read_file' },
      });
      expect(served).toMatchObject({ call: { id: 'call_1', name: 'read_file' } });
      expect(entry).not.toHaveProperty('call.input');
    },
  );

  it.each([
    ['a text delta', { type: 'text_delta', text: HUGE }],
    ['a reasoning item', { type: 'reasoning', item: { source: 'model', data: HUGE } }],
    [
      'a batch of calls, which has several and no one of its own',
      { type: 'tool_batch', calls: [{ ...described(), description: HUGE }] },
    ],
  ])('has no call for %s', (_name, body) => {
    const { entry } = storedStub(body);

    expect(entry).not.toHaveProperty('call');
  });

  it('cuts a tool name over the bound and keeps the id whole', () => {
    const name = 'n'.repeat(MAX_OMITTED_CALL_CHARS + 50);
    const { entry, served } = storedStub(callEvents({ name }).tool_result);

    expect(entry).toMatchObject({
      call: { id: 'call_1', name: 'n'.repeat(MAX_OMITTED_CALL_CHARS) },
    });
    expect(served).toHaveProperty('call');
  });

  it('keeps a tool name cut inside a surrogate pair well formed', () => {
    const name = `${'n'.repeat(MAX_OMITTED_CALL_CHARS - 1)}😀`;
    const { entry } = storedStub(callEvents({ name }).tool_result);

    expect(entry).toMatchObject({ call: { name: 'n'.repeat(MAX_OMITTED_CALL_CHARS - 1) } });
  });

  it('keeps an id of exactly the bound, whole', () => {
    const id = 'i'.repeat(MAX_OMITTED_CALL_CHARS);
    const { entry } = storedStub(callEvents({ id }).tool_result);

    expect(entry).toMatchObject({ call: { id } });
  });

  it.each([
    ['an id over the bound, which is never cut', 'i'.repeat(MAX_OMITTED_CALL_CHARS + 1)],
    ['an empty id', ''],
    ['an id with a lone surrogate', 'call_\uD800'],
  ])('has no call for %s', (_name, id) => {
    const { entry } = storedStub(callEvents({ id }).tool_result);

    expect(entry).not.toHaveProperty('call');
  });

  it('is far inside a stored entry whatever the call holds: control characters cost the most, and an id and a name at the bound are the worst', () => {
    // `\u0000` is six characters of JSON each, so this is the longest a header can be.
    const worst = '\u0000'.repeat(MAX_OMITTED_CALL_CHARS);
    const { entry } = storedStub(callEvents({ id: worst, name: worst }).tool_result);

    expect(entry).toHaveProperty('call.id', worst);
    expect(JSON.stringify(entry).length).toBeLessThan(MAX_CHANNEL_ENTRY_CHARS / 8);
  });
});

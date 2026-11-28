import { describe, expect, it } from 'vitest';
import { streamEntrySchema } from '../../stream/stream.validator.js';
import { isWellFormedChannelLog } from '../channel.utils.js';
import { channelEntrySchema, channelLogSchema } from '../channel.validator.js';

const ITEM_ID = '3f1b2c4d-5e6f-4a7b-8c9d-0e1f2a3b4c5d';
const MESSAGE = '9a8b7c6d-5e4f-4a3b-8c2d-1e0f9a8b7c6d';
const AGENT = { kind: 'agent', id: 'agent-1', title: 'Main', state: 'running', startedAt: 1 };

/** An `item` entry of agent-1's channel holding a message, unless `more` changes it. */
const itemEntry = (more: object = {}) => ({
  channel: 'agent-1',
  cursor: 's4',
  at: 5,
  type: 'item',
  item: { kind: 'message', id: ITEM_ID, text: 'Done.', reason: 'completed' },
  ...more,
});

const opened = (more: object = {}) => ({
  channel: 'agent-1',
  cursor: 's0',
  at: 1,
  type: 'opened',
  node: AGENT,
  ...more,
});

const served = (value: unknown) => channelEntrySchema.safeParse(value).success;

describe('an item on an agent’s channel', () => {
  it('is an entry a subscription serves, with the message it belongs to when there is one', () => {
    expect(served(itemEntry())).toBe(true);
    expect(served(itemEntry({ messageId: MESSAGE }))).toBe(true);
  });

  it.each([
    ['the first cursor, which is the opened entry’s', itemEntry({ cursor: 's0' })],
    ['a byte cursor', itemEntry({ cursor: 'b9' })],
    ['a command’s channel, which counts bytes', itemEntry({ channel: 't1', cursor: 'b9' })],
    ['the tree channel', itemEntry({ channel: 'tree' })],
    ['a message that is not an id', itemEntry({ messageId: 'not-a-message-id' })],
    ['no item', itemEntry({ item: undefined })],
    ['an item that is not one', itemEntry({ item: { kind: 'message', id: ITEM_ID } })],
  ])('is not %s', (_name, value) => {
    expect(served(value)).toBe(false);
  });

  it('is an entry of a numbered log between its boundaries', () => {
    const entry = (type: string, cursor: string) => ({ channel: 'agent-1', cursor, at: 1, type });
    const log = [entry('opened', 's0'), itemEntry({ cursor: 's1' }), entry('closed', 's2')];

    expect(isWellFormedChannelLog(log)).toBe(true);
    expect(channelLogSchema.safeParse(log).success).toBe(true);
  });

  it('is not an entry of the combined stream', () => {
    expect(
      streamEntrySchema.safeParse({
        seq: 0,
        sessionId: 'session-1',
        at: 1,
        kind: 'event',
        event: { seq: 0, type: 'item_completed', item: itemEntry().item },
      }).success,
    ).toBe(false);
  });
});

describe('the form of a channel, on its opened entry', () => {
  it('is absent in the earlier form, so a channel written before it still reads', () => {
    expect(served(opened())).toBe(true);
  });

  it('is a positive whole number when it is named', () => {
    expect(served(opened({ format: 1 }))).toBe(true);
    expect(served(opened({ format: 2 }))).toBe(true);
  });

  it.each([0, -1, 1.5, '2', null])('is not %j', (format) => {
    expect(served(opened({ format }))).toBe(false);
  });
});

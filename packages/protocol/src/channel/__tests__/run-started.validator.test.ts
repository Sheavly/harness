import { describe, expect, it } from 'vitest';
import { MAX_QUEUED_LINE_CHARS } from '../../server/server.constants.js';
import { conversationEntrySchema } from '../../subscription/subscription.utils.js';
import { isWellFormedChannelLog } from '../channel.utils.js';
import { channelEntrySchema } from '../channel.validator.js';

const MESSAGE = '3f1b2c4d-5e6f-4a7b-8c9d-0e1f2a3b4c5d';

/** A `run_started` entry of agent-1's channel: a prompt's, with its text, unless `more` changes it. */
const runStarted = (more: object = {}) => ({
  channel: 'agent-1',
  cursor: 's3',
  at: 5,
  type: 'run_started',
  cause: 'prompt',
  messageId: MESSAGE,
  text: 'Inspect the project',
  ...more,
});

/** A wake's `run_started`: no text. */
const wake = (more: object = {}) => ({
  channel: 'agent-1',
  cursor: 's9',
  at: 8,
  type: 'run_started',
  cause: 'wake',
  messageId: MESSAGE,
  ...more,
});

const served = (value: unknown) => channelEntrySchema.safeParse(value).success;

describe('where a run starts on an agent’s channel', () => {
  it('says, for a user’s prompt, the message it answers and the prompt’s text', () => {
    expect(served(runStarted())).toBe(true);
    expect(served(runStarted({ text: '' }))).toBe(true);
  });

  it('says, for a wake, the message the run goes on from, and no text', () => {
    expect(served(wake())).toBe(true);
  });

  it('keeps the text to the length of a queued line, as the tree channel’s prompt_started does', () => {
    expect(served(runStarted({ text: 'x'.repeat(MAX_QUEUED_LINE_CHARS) }))).toBe(true);
    expect(served(runStarted({ text: 'x'.repeat(MAX_QUEUED_LINE_CHARS + 1) }))).toBe(false);
  });

  it.each([
    ['a prompt with no text', wake({ cause: 'prompt' })],
    ['a wake with text', wake({ text: 'continue' })],
    ['a cause that is not one', runStarted({ cause: 'retry' })],
    ['no cause', runStarted({ cause: undefined })],
    ['no message', runStarted({ messageId: undefined })],
    ['a message that is not an id', runStarted({ messageId: 'not-a-message-id' })],
    ['the first cursor, which is the opened entry’s', runStarted({ cursor: 's0' })],
    ['a byte cursor', runStarted({ cursor: 'b9' })],
    ['a command’s channel, which counts bytes', runStarted({ channel: 't1', cursor: 'b9' })],
    ['the tree channel', runStarted({ channel: 'tree' })],
    ['the usage channel', runStarted({ channel: 'usage' })],
  ])('refuses %s', (_name, value) => {
    expect(served(value)).toBe(false);
  });

  it('is an entry of an agent’s numbered log between its boundaries', () => {
    const entry = (type: string, cursor: string) => ({ channel: 'agent-1', cursor, at: 1, type });

    expect(
      isWellFormedChannelLog([
        entry('opened', 's0'),
        entry('run_started', 's1'),
        entry('event', 's2'),
        entry('closed', 's3'),
      ]),
    ).toBe(true);
  });
});

describe('the conversation’s own channels', () => {
  it.each(['tree', 'usage'] as const)(
    'never hold a run_started: the %s channel refuses it',
    (name) => {
      const entry = { channel: name, cursor: 's3', at: 5, type: 'run_started', cause: 'wake' };

      expect(
        conversationEntrySchema(name).safeParse({ ...entry, messageId: MESSAGE }).success,
      ).toBe(false);
    },
  );
});

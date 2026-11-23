import { describe, expect, it } from 'vitest';
import { serverErrorCodeSchema } from '../../server/server.validator.js';
import { MAX_NODE_MESSAGE_CHARS } from '../node-command.constants.js';
import { messageNodeRequestSchema, promptSentSchema } from '../node-command.validator.js';

const MESSAGE_ID = '0f8fad5b-d9cb-469f-a165-70867728950e';

describe('a message to a node', () => {
  it.each([['one line'], ['a longer one\nover two lines'], ['x'.repeat(MAX_NODE_MESSAGE_CHARS)]])(
    'takes text: %#',
    (text) => {
      expect(messageNodeRequestSchema.safeParse({ text }).success).toBe(true);
    },
  );

  it.each([
    ['no text', {}],
    ['empty text', { text: '' }],
    ['text over the cap', { text: 'x'.repeat(MAX_NODE_MESSAGE_CHARS + 1) }],
    ['text that is not text', { text: 5 }],
  ])('is not %s', (_name, value) => {
    expect(messageNodeRequestSchema.safeParse(value).success).toBe(false);
  });

  it('does not say who sent it: the caller is the sender', () => {
    expect(messageNodeRequestSchema.parse({ text: 'go', from: 'agent-9' })).toEqual({ text: 'go' });
  });
});

describe('the answer to a prompt sent', () => {
  it.each([
    [
      'one that started, with the message it became',
      { status: 'started', node: 'agent-1', messageId: MESSAGE_ID, queued: [] },
    ],
    [
      'one that started while others wait',
      { status: 'started', node: 'agent-1', messageId: MESSAGE_ID, queued: ['next'] },
    ],
    [
      'one that waits, with no message yet',
      { status: 'queued', node: 'agent-1', queued: ['this one'] },
    ],
  ])('is %s', (_name, value) => {
    expect(promptSentSchema.safeParse(value).success).toBe(true);
  });

  it.each([
    [
      'a prompt that started with no message id',
      { status: 'started', node: 'agent-1', queued: [] },
    ],
    [
      'a prompt that started with a message id that is not one',
      { status: 'started', node: 'agent-1', messageId: 'm1', queued: [] },
    ],
    [
      'a prompt that waits and already has a message id',
      { status: 'queued', node: 'agent-1', messageId: MESSAGE_ID, queued: ['x'] },
    ],
    ['an answer with no node', { status: 'queued', queued: [] }],
    ['an answer whose node is the tree', { status: 'queued', node: 'tree', queued: [] }],
    ['a status it does not have', { status: 'refused', node: 'agent-1', queued: [] }],
  ])('is not %s', (_name, value) => {
    expect(promptSentSchema.safeParse(value).success).toBe(false);
  });
});

describe('the refusal of a command to a node that ended', () => {
  it('is a code of its own, apart from a node that is not there', () => {
    expect(serverErrorCodeSchema.options).toContain('node_ended');
    expect(serverErrorCodeSchema.options).toContain('not_found');
  });
});

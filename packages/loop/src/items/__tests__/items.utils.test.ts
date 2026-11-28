import { describe, expect, it } from 'vitest';
import { ConnectionLostError } from '@sheavly/core/errors/connection.errors';
import { itemIdSchema, itemSchema } from '@sheavly/protocol/item/item.validator';
import type { ToolCall, ToolMessage } from '@sheavly/protocol/message/message.types';
import { callIdSchema } from '@sheavly/protocol/message/message.validator';
import { STOPPED_BY_FAILURE } from '../../stream-agent/stream-agent.constants.js';
import { completedTool, cutAtCodePoint, messageReason, splitForRoom } from '../items.utils.js';

const ID = itemIdSchema.parse('2f1c8a52-6a53-4a3b-9d62-0f4e1c1d9b11');
const call: ToolCall = {
  id: callIdSchema.parse('c1'),
  name: 'run',
  input: { description: 'running', cmd: 'ls' },
};
const described = { call, description: 'running ls' };

const tool = (params: { content: string; isError: boolean }): ToolMessage => ({
  role: 'tool',
  toolCallId: call.id,
  ...params,
  at: 1,
});

describe('how a message ended', () => {
  const lost = new ConnectionLostError({ reason: 'dropped', message: 'dropped' });

  const run = { aborted: false, failure: undefined, stopReason: 'end_turn' } as const;
  const stopped = { ...run, aborted: true };

  it.each([
    { name: 'a normal end', ...run, reason: 'completed' },
    {
      name: 'an output cut off by the limit',
      ...run,
      stopReason: 'max_tokens',
      reason: 'completed',
    },
    {
      name: 'a call the context window did not fit',
      ...run,
      stopReason: 'context_window_exceeded',
      reason: 'failed',
    },
    { name: 'a run the user stopped', ...stopped, reason: 'interrupted' },
    {
      name: 'a stop that came with a failure',
      ...stopped,
      failure: { error: new Error('x') },
      reason: 'interrupted',
    },
    { name: 'a lost connection', ...run, failure: { error: lost }, reason: 'interrupted' },
    {
      name: 'any other failure of the model call',
      ...run,
      failure: { error: new Error('x') },
      reason: 'failed',
    },
  ] as const)('is $name: $reason', ({ aborted, failure, stopReason, reason }) => {
    const signal = aborted ? AbortSignal.abort() : new AbortController().signal;

    expect(messageReason({ signal, failure, stopReason })).toBe(reason);
  });
});

describe('cutting text at a code point', () => {
  it('leaves text that fits alone and cuts one that does not at the bound', () => {
    expect(cutAtCodePoint({ text: 'abc', max: 3 })).toBe('abc');
    expect(cutAtCodePoint({ text: 'abcd', max: 3 })).toBe('abc');
  });

  it('moves the cut one unit earlier when it would split a pair', () => {
    expect(cutAtCodePoint({ text: 'a\u{1F600}', max: 2 })).toBe('a');
    expect(splitForRoom({ text: 'a\u{1F600}b', room: 2 })).toEqual({
      head: 'a',
      rest: '\u{1F600}b',
    });
    expect(splitForRoom({ text: '\u{1F600}', room: 0 })).toEqual({ head: '', rest: '\u{1F600}' });
  });
});

describe('the completed item of a tool call', () => {
  it('holds the result of a tool that settled, with the artifacts only when there are some', () => {
    const message = tool({ content: 'out', isError: false });
    const artifacts = [{ kind: 'file_read' }];
    const base = { id: ID, described, turn: 1, message, reason: 'completed' } as const;
    const withArtifacts = completedTool({
      ...base,
      outcome: { type: 'tool_result', ...described, message, durationMs: 5, artifacts },
    });
    const without = completedTool({
      ...base,
      outcome: { type: 'tool_result', ...described, message, durationMs: 5 },
    });

    expect(withArtifacts).toMatchObject({ result: { content: 'out', isError: false, artifacts } });
    expect(without).not.toHaveProperty('result.artifacts');
    expect(itemSchema.safeParse(withArtifacts).success).toBe(true);
    expect(itemSchema.safeParse(without).success).toBe(true);
  });

  it.each(['interrupted', 'failed'] as const)(
    'holds the placeholder result of a call stopped before it settled, with the reason %s',
    (reason) => {
      const message = tool({ content: STOPPED_BY_FAILURE, isError: true });
      const item = completedTool({
        id: ID,
        described,
        turn: 2,
        message,
        reason,
        outcome: { type: 'tool_result', ...described, message, durationMs: 3 },
      });

      expect(item).toMatchObject({
        reason,
        turn: 2,
        result: { content: STOPPED_BY_FAILURE, isError: true, durationMs: 3 },
      });
      expect(itemSchema.safeParse(item).success).toBe(true);
    },
  );
});

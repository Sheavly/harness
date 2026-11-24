import { describe, expect, it } from 'vitest';
import { agentEventBodySchema, agentEventSchema, entryEventSchema } from '../event.validator.js';
import {
  MAX_EXTENSION_DATA_BYTES,
  MAX_EXTENSION_TEXT_CHARS,
} from '../../extension/extension.constants.js';

const CALL = {
  call: { id: 'call-1', name: 'read_file', input: { path: 'a.ts' } },
  description: 'reading a.ts',
};
const SESSION = { id: 'main', rootId: 'main', depth: 1 };

const EXTENSION_EVENT = {
  type: 'extension_event',
  extension: 'acme',
  kind: 'acme.deploy-finished',
  version: 2,
  data: { ok: true, steps: [1, 2, null], note: 'done' },
  text: 'Deploy finished',
};

describe('extension_event', () => {
  it('round trips through the run and the stream schemas', () => {
    const event = { seq: 0, ...EXTENSION_EVENT };

    expect(agentEventSchema.parse(JSON.parse(JSON.stringify(event)))).toEqual(event);
    expect(entryEventSchema.parse(JSON.parse(JSON.stringify(event)))).toEqual(event);
  });

  it('parses a kind the reader does not know: the union is closed in type, open in kind', () => {
    const event = { seq: 3, ...EXTENSION_EVENT, extension: 'other', kind: 'other.never-seen' };

    expect(entryEventSchema.parse(event)).toEqual(event);
  });

  it('rejects a kind outside the extension namespace, even one that looks close', () => {
    for (const kind of ['other.thing', 'acmeco.thing', 'acme-thing', 'thing', 'acme.']) {
      expect(agentEventBodySchema.safeParse({ ...EXTENSION_EVENT, kind }).success).toBe(false);
    }
  });

  it('rejects a name that is not kebab-case', () => {
    for (const extension of ['Acme', 'acme_co', '', 'acme.co']) {
      const event = { ...EXTENSION_EVENT, extension, kind: `${extension}.x` };

      expect(agentEventBodySchema.safeParse(event).success).toBe(false);
    }
  });

  it.each([0, -1, 1.5, '1', null])('rejects the version %j', (version) => {
    expect(agentEventBodySchema.safeParse({ ...EXTENSION_EVENT, version }).success).toBe(false);
  });

  it('rejects empty text and text over the cap, and accepts text at the cap', () => {
    const withText = (text: string) => ({ ...EXTENSION_EVENT, text });

    expect(agentEventBodySchema.safeParse(withText('')).success).toBe(false);
    expect(
      agentEventBodySchema.safeParse(withText('x'.repeat(MAX_EXTENSION_TEXT_CHARS + 1))).success,
    ).toBe(false);
    expect(
      agentEventBodySchema.safeParse(withText('x'.repeat(MAX_EXTENSION_TEXT_CHARS))).success,
    ).toBe(true);
  });

  it('caps the serialized size of data, counted in bytes', () => {
    const withData = (data: unknown) => ({ ...EXTENSION_EVENT, data });
    const overhead = JSON.stringify('').length;
    const fits = 'x'.repeat(MAX_EXTENSION_DATA_BYTES - overhead);

    expect(agentEventBodySchema.safeParse(withData(fits)).success).toBe(true);
    expect(agentEventBodySchema.safeParse(withData(`${fits}x`)).success).toBe(false);
    // Three bytes per character: few characters, over the byte cap.
    expect(agentEventBodySchema.safeParse(withData('€'.repeat(6000))).success).toBe(false);
  });

  it('requires data, and rejects a value JSON cannot carry', () => {
    const { data: _data, ...withoutData } = EXTENSION_EVENT;

    expect(agentEventBodySchema.safeParse(withoutData).success).toBe(false);
    expect(
      agentEventBodySchema.safeParse({ ...EXTENSION_EVENT, data: { at: undefined } }).success,
    ).toBe(false);
  });
});

describe('agentEventSchema', () => {
  it('accepts every event kind with its seq', () => {
    const bodies = [
      { type: 'text_delta', text: 'hi' },
      { type: 'harness_notice', notice: { kind: 'context-usage', context: { used: 100 } } },
      { type: 'reasoning', item: { source: 'openai:gpt', data: { encrypted: 'x' } } },
      { type: 'reasoning_activity', active: true },
      { type: 'run_state', state: 'waiting', groupedTasks: 2 },
      { type: 'tool_call_started', ...CALL },
      { type: 'turn_end', turn: 1, stopReason: 'interrupted' },
      { type: 'tool_batch', calls: [CALL] },
      {
        type: 'tool_result',
        ...CALL,
        message: { role: 'tool', toolCallId: 'call-1', content: 'ok', isError: false },
        durationMs: 3,
      },
      { type: 'context_added', hook: 'agents-md', content: 'rules' },
      { type: 'model_input_changed', hook: 'trim', turn: 2, added: 0, removed: 3, edited: 1 },
      { type: 'summary_started', reason: 'threshold', tokensBefore: 255_000, messagesBefore: 80 },
      {
        type: 'summary_done',
        tokensBefore: 255_000,
        tokensAfter: 19_000,
        messagesBefore: 80,
        messagesAfter: 21,
        summarized: 60,
        kept: 20,
        summarizer: 'model',
        sections: [{ id: 'goal', title: 'Goal', chars: 420 }],
      },
      {
        type: 'summary_failed',
        kind: 'generation',
        reason: 'overflow',
        error: 'provider down',
        retriesLeft: 2,
      },
      { type: 'hook_failed', hook: 'h', handler: 'onError', error: 'boom' },
      { type: 'storage_failed', error: 'Could not store entry 4: disk full' },
      { type: 'message_received', message: { from: 'user', content: 'stop', sentAt: 1 } },
      {
        type: 'done',
        reason: 'completed',
        messages: [{ role: 'user', content: 'go' }],
        session: SESSION,
      },
    ];

    bodies.forEach((body, seq) => {
      expect(agentEventSchema.parse({ seq, ...body })).toEqual({ seq, ...body });
    });
  });

  it('keeps reasoning_activity content-free: any extra field is rejected', () => {
    // The body schema, not `agentEventSchema`: its intersection with `seq` lets extra keys through.
    const activity = { type: 'reasoning_activity', active: true };

    expect(agentEventBodySchema.safeParse(activity).success).toBe(true);

    for (const extra of [{ text: 'secret' }, { encrypted_content: 'x' }, { item: {} }]) {
      expect(agentEventBodySchema.safeParse({ ...activity, ...extra }).success).toBe(false);
    }
  });

  it('rejects a run_state with an unknown state or a negative or missing count', () => {
    const state = { seq: 0, type: 'run_state', state: 'working', groupedTasks: 0 };

    expect(agentEventSchema.safeParse(state).success).toBe(true);
    expect(agentEventSchema.safeParse({ ...state, state: 'ready' }).success).toBe(false);
    expect(agentEventSchema.safeParse({ ...state, groupedTasks: -1 }).success).toBe(false);
    expect(
      agentEventSchema.safeParse({ seq: 0, type: 'run_state', state: 'working' }).success,
    ).toBe(false);
  });

  it('rejects a summary event with an unknown reason or a negative count', () => {
    const started = { seq: 0, type: 'summary_started', tokensBefore: 1, messagesBefore: 1 };

    expect(agentEventSchema.safeParse({ ...started, reason: 'threshold' }).success).toBe(true);
    expect(agentEventSchema.safeParse({ ...started, reason: 'whenever' }).success).toBe(false);
    expect(
      agentEventSchema.safeParse({ ...started, reason: 'manual', tokensBefore: -1 }).success,
    ).toBe(false);
    expect(
      agentEventSchema.safeParse({
        seq: 1,
        type: 'summary_failed',
        kind: 'size',
        reason: 'whenever',
        error: 'x',
        retriesLeft: 0,
      }).success,
    ).toBe(false);
  });

  it('requires the kind of a failed summary, one of the four', () => {
    const failed = {
      seq: 0,
      type: 'summary_failed',
      reason: 'manual',
      error: 'x',
      retriesLeft: 0,
    };

    for (const kind of ['generation', 'preservation', 'size', 'cancellation']) {
      expect(agentEventSchema.safeParse({ ...failed, kind }).success).toBe(true);
    }

    expect(agentEventSchema.safeParse({ ...failed, kind: 'other' }).success).toBe(false);
  });

  it('lets done carry a history that holds a checkpoint', () => {
    const messages = [
      { role: 'user', content: 'start' },
      { role: 'user', content: 'go' },
      {
        role: 'summary',
        sections: [{ id: 'goal', title: 'Goal', body: 'Fix it.' }],
        kept: 1,
        summarized: 4,
        covered: 1,
        summarizer: 'model',
        at: 1,
      },
    ];
    const done = { seq: 0, type: 'done', reason: 'completed', messages, session: SESSION };

    expect(agentEventSchema.parse(done)).toEqual(done);
  });

  it('refuses a summary_done that kept nothing, like the checkpoint it announces', () => {
    const done = {
      seq: 0,
      type: 'summary_done',
      tokensBefore: 10,
      tokensAfter: 5,
      messagesBefore: 4,
      messagesAfter: 2,
      summarized: 3,
      kept: 1,
      summarizer: 'model',
      sections: [],
    };

    expect(agentEventSchema.safeParse(done).success).toBe(true);
    expect(agentEventSchema.safeParse({ ...done, kept: 0 }).success).toBe(false);
  });

  it('keeps the fields of a tool artifact it does not know', () => {
    const artifact = { kind: 'table', rows: [[1, 2]] };
    const event = agentEventSchema.parse({
      seq: 0,
      type: 'tool_result',
      ...CALL,
      message: { role: 'tool', toolCallId: 'call-1', content: 'ok', isError: false },
      durationMs: 1,
      artifacts: [artifact],
    });

    expect(event).toMatchObject({ artifacts: [artifact] });
  });

  describe('task_running', () => {
    const RUNNING = {
      seq: 4,
      type: 'task_running',
      ...CALL,
      task: {
        id: 't1',
        kind: 'agent',
        command: 'sub-agent: Check docs',
        description: 'checking docs',
        status: 'running',
        startedAt: 1,
        output: '',
      },
      nodeId: '4f0c2a9e-1d3b-4e57-8a61-0c9d7b2e5f13',
      message: { role: 'tool', toolCallId: 'call-1', content: 'started', isError: false },
      durationMs: 1,
    };

    it('carries the node the call launched, which the child does not have until it exists', () => {
      expect(agentEventSchema.parse(RUNNING)).toMatchObject({ nodeId: RUNNING.nodeId });
      expect(entryEventSchema.parse(RUNNING)).toMatchObject({ nodeId: RUNNING.nodeId });
    });

    it('still reads an event stored before the node id existed, so that conversation reopens', () => {
      const { nodeId: _nodeId, ...stored } = RUNNING;

      expect(entryEventSchema.parse(stored)).not.toHaveProperty('nodeId');
      expect(agentEventSchema.parse(stored)).toMatchObject({ type: 'task_running' });
    });

    it('is refused with a node id a node cannot have', () => {
      // Capitals, a space, an over-long id and the tree channel's name are not node ids.
      for (const nodeId of ['', 'T1', 'tree', 'with space', 'x'.repeat(129)]) {
        expect(agentEventSchema.safeParse({ ...RUNNING, nodeId }).success).toBe(false);
      }
    });

    it('keeps the session a sub-agent task runs, the stable key to its agent', () => {
      const withAgent = { ...RUNNING, task: { ...RUNNING.task, agentSessionId: 'child-1' } };

      expect(agentEventSchema.parse(withAgent)).toMatchObject({
        task: { agentSessionId: 'child-1' },
      });
    });
  });

  it('rejects an event without seq, with a negative seq, or of an unknown kind', () => {
    expect(agentEventSchema.safeParse({ type: 'text_delta', text: 'hi' }).success).toBe(false);
    expect(agentEventSchema.safeParse({ seq: -1, type: 'text_delta', text: 'hi' }).success).toBe(
      false,
    );
    expect(agentEventSchema.safeParse({ seq: 0, type: 'shout', text: 'hi' }).success).toBe(false);
  });

  it('rejects a model_input_changed with a negative or missing count', () => {
    const event = { seq: 0, type: 'model_input_changed', hook: 'trim', turn: 1 };

    const counts = { added: 0, removed: 1, edited: 0 };

    expect(agentEventSchema.safeParse({ ...event, ...counts }).success).toBe(true);
    expect(agentEventSchema.safeParse({ ...event, ...counts, added: -1 }).success).toBe(false);
    expect(agentEventSchema.safeParse({ ...event, added: 0, removed: 1 }).success).toBe(false);
    expect(agentEventSchema.safeParse({ ...event, added: 0 }).success).toBe(false);
  });

  it('rejects an artifact without a kind and a message with an unknown role', () => {
    const result = {
      seq: 0,
      type: 'tool_result',
      ...CALL,
      message: { role: 'tool', toolCallId: 'call-1', content: 'ok', isError: false },
      durationMs: 1,
    };

    expect(agentEventSchema.safeParse({ ...result, artifacts: [{ rows: [] }] }).success).toBe(
      false,
    );
    expect(
      agentEventSchema.safeParse({ ...result, message: { role: 'system', content: 'x' } }).success,
    ).toBe(false);
  });
});

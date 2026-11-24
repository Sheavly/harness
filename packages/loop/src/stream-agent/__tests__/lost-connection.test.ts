import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { ConnectionLostError } from '@sheavly/core/errors/connection.errors';
import { defineTool } from '@sheavly/core/tool/tool.utils';
import type { StreamEvent } from '@sheavly/core/message/message.types';
import type { Provider, ProviderRequest } from '@sheavly/core/provider/provider.types';
import type { AgentEvent } from '@sheavly/protocol/event/event.types';
import type { ToolCall } from '@sheavly/protocol/message/message.types';
import { callIdSchema } from '@sheavly/protocol/message/message.validator';
import { STOPPED_BY_FAILURE } from '../stream-agent.constants.js';
import { streamAgent } from '../stream-agent.helper.js';

const lost = () =>
  new ConnectionLostError({ reason: 'dropped', message: 'the connection dropped' });
const done: StreamEvent = { type: 'done', stopReason: 'end_turn' };
const call: ToolCall = {
  id: callIdSchema.parse('call-1'),
  name: 'slow',
  input: { description: 'x' },
};

/** One scripted model call: what it streams, then either `lost` or its end. */
type Step = { events: StreamEvent[]; drops?: boolean };

/** A provider that plays `steps` in turn, and keeps what each call was sent. */
function provider(steps: Step[]) {
  const requests: ProviderRequest[] = [];
  const model: Provider = {
    async *stream(request) {
      const step = steps[requests.length] ?? { events: [done] };

      requests.push(request);
      yield* step.events;

      if (step.drops) throw lost();
    },
  };

  return { model, requests };
}

const slow = defineTool({
  name: 'slow',
  description: 'Finishes after a moment',
  inputSchema: z.object({}),
  execute: async () => {
    await new Promise((resolve) => setTimeout(resolve, 20));

    return 'finished';
  },
});

async function run(model: Provider, options: { maxOutputContinuations?: number } = {}) {
  const events: AgentEvent[] = [];
  const failure = await (async () => {
    for await (const event of streamAgent({
      ...options,
      provider: model,
      tools: [slow],
      messages: [{ role: 'user', content: 'go' }],
    })) {
      events.push(event);
    }
  })().then(
    () => undefined,
    (caughtError: unknown) => caughtError,
  );
  const end = events.at(-1);

  return { events, failure, history: end?.type === 'done' ? end.messages : [] };
}

/** The run ended with `run_failed`, and the error it failed with is the lost connection. */
function expectFailedWithLostConnection(outcome: { events: AgentEvent[]; failure: unknown }) {
  expect(outcome.failure).toBeInstanceOf(ConnectionLostError);
  expect(outcome.events.map((event) => event.type)).toContain('run_failed');
}

describe('a reply cut by a lost connection', () => {
  it('keeps the text that arrived and asks the model to go on, without failing the run', async () => {
    const { model, requests } = provider([
      { events: [{ type: 'text_delta', text: 'par' }], drops: true },
      { events: [{ type: 'text_delta', text: 'tial' }, done] },
    ]);
    const { events, failure, history } = await run(model);

    expect(failure).toBeUndefined();
    expect(events.map((event) => event.type)).not.toContain('run_failed');
    expect(events.at(-1)).toMatchObject({ type: 'done', reason: 'completed' });
    expect(history.map((message) => message.role)).toEqual(['user', 'assistant', 'assistant']);
    expect(history[1]).toMatchObject({ content: 'par' });
    expect(history[2]).toMatchObject({ content: 'tial' });
    expect(requests[0]?.notices ?? []).not.toContainEqual(
      expect.objectContaining({ kind: 'output-continuation' }),
    );
    expect(requests[1]?.notices).toContainEqual(
      expect.objectContaining({ kind: 'output-continuation', reason: 'connection' }),
    );
  });

  it('ends the cut turn as `connection_lost`, not as an interrupt', async () => {
    const { model } = provider([
      { events: [{ type: 'text_delta', text: 'par' }], drops: true },
      { events: [{ type: 'text_delta', text: 'tial' }, done] },
    ]);
    const { events } = await run(model);
    const stops = events.flatMap((event) => (event.type === 'turn_end' ? [event.stopReason] : []));

    expect(stops).toEqual(['connection_lost', 'end_turn']);
  });

  it('spends none of the output limit’s allowance, even one set to zero', async () => {
    const { model } = provider([
      { events: [{ type: 'text_delta', text: 'par' }], drops: true },
      { events: [{ type: 'text_delta', text: 'tial' }, done] },
    ]);
    const { events, failure } = await run(model, { maxOutputContinuations: 0 });

    expect(failure).toBeUndefined();
    expect(events.at(-1)).toMatchObject({ type: 'done', reason: 'completed' });
  });

  it('drops a reply that kept only its reasoning, which a provider would not take back alone', async () => {
    const reasoning: StreamEvent = {
      type: 'reasoning',
      item: { source: 'test:model', data: { opaque: 'x' } },
    };
    const { model } = provider([
      { events: [reasoning], drops: true },
      { events: [{ type: 'text_delta', text: 'hi' }, done] },
    ]);
    const { failure, history } = await run(model);

    expect(failure).toBeUndefined();
    expect(history.map((message) => message.role)).toEqual(['user', 'assistant']);
    expect(history[1]).toMatchObject({ content: 'hi' });
  });

  it('leaves no empty reply in history when the connection was lost before anything arrived', async () => {
    const { model } = provider([
      { events: [], drops: true },
      { events: [{ type: 'text_delta', text: 'hi' }, done] },
    ]);
    const { failure, history } = await run(model);

    expect(failure).toBeUndefined();
    expect(history.map((message) => message.role)).toEqual(['user', 'assistant']);
    expect(history[1]).toMatchObject({ content: 'hi' });
  });

  it('lets a tool the model already called finish, and records its real result', async () => {
    const { model } = provider([
      { events: [{ type: 'tool_call', call }], drops: true },
      { events: [{ type: 'text_delta', text: 'ok' }, done] },
    ]);
    const { failure, history } = await run(model);
    const result = history.find((message) => message.role === 'tool');

    expect(failure).toBeUndefined();
    expect(result).toMatchObject({ content: 'finished', isError: false });
    expect(JSON.stringify(history)).not.toContain(STOPPED_BY_FAILURE);
    expect(history.at(-1)).toMatchObject({ role: 'assistant', content: 'ok' });
  });

  it('fails the run with the error once replies keep being lost with nothing kept', async () => {
    const { model, requests } = provider(
      Array.from({ length: 10 }, () => ({ events: [], drops: true })),
    );
    const outcome = await run(model);

    expectFailedWithLostConnection(outcome);
    // The same bound as any other loss: the sixth in a row fails the run.
    expect(requests).toHaveLength(6);
  });

  const piece = (text: string): StreamEvent => ({ type: 'text_delta', text });
  const losing = (count: number): Step[] =>
    Array.from({ length: count }, (_, index): Step => ({
      events: [piece(`${index}`)],
      drops: true,
    }));

  it('keeps going while each lost reply kept something, up to five calls in a row', async () => {
    const { model, requests } = provider([...losing(5), { events: [piece('end'), done] }]);
    const { failure, history } = await run(model);

    expect(failure).toBeUndefined();
    expect(requests).toHaveLength(6);
    expect(history.filter((message) => message.role === 'assistant')).toHaveLength(6);
  });

  it('fails the run with the error at the sixth in a row, however much each one kept', async () => {
    const { model, requests } = provider([...losing(8), { events: [done] }]);

    expectFailedWithLostConnection(await run(model));
    expect(requests).toHaveLength(6);
  });

  it('starts the count again after a call that completed', async () => {
    const turn: Step = {
      events: [
        { type: 'tool_call', call },
        { type: 'done', stopReason: 'tool_use' },
      ],
    };
    const { model, requests } = provider([
      ...losing(4),
      turn,
      ...losing(4),
      { events: [piece('end'), done] },
    ]);
    const { failure } = await run(model);

    expect(failure).toBeUndefined();
    expect(requests).toHaveLength(10);
  });

  it('is not recovered when it is any other failure of the provider', async () => {
    const broken: Provider = {
      async *stream() {
        yield { type: 'text_delta', text: 'par' };
        throw new Error('the model refused');
      },
    };
    const { failure } = await run(broken);

    expect(failure).toMatchObject({ message: 'the model refused' });
  });
});

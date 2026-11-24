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

const piece = (text: string): StreamEvent => ({ type: 'text_delta', text });

/** A first call cut after `kept`, then a second that finishes the reply with `tail`. */
const cutThenFinish = (params: { kept: StreamEvent[]; tail?: string }): Step[] => [
  { events: params.kept, drops: true },
  { events: [piece(params.tail ?? 'tial'), done] },
];

/** `count` calls in a row, each cut after one word. */
const losing = (count: number): Step[] =>
  Array.from({ length: count }, (_, index): Step => ({
    events: [piece(`${index}`)],
    drops: true,
  }));

/** The `stopReason` of every `turn_end` of a run, in order. */
const stopsOf = (events: AgentEvent[]) =>
  events.flatMap((event) => (event.type === 'turn_end' ? [event.stopReason] : []));

async function run(
  model: Provider,
  options: { maxOutputContinuations?: number; maxTurns?: number; signal?: AbortSignal } = {},
) {
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
    const { model, requests } = provider(cutThenFinish({ kept: [piece('par')] }));
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
    const { model } = provider(cutThenFinish({ kept: [piece('par')] }));
    const { events } = await run(model);

    expect(stopsOf(events)).toEqual(['connection_lost', 'end_turn']);
  });

  it('is not a recovery when the run was interrupted: the turn ends `interrupted` and the run stops', async () => {
    const controller = new AbortController();
    const interrupting: Provider = {
      async *stream() {
        yield piece('par');
        controller.abort();
        throw lost();
      },
    };
    const { events } = await run(interrupting, { signal: controller.signal });

    expect(stopsOf(events)).toEqual(['interrupted']);
    expect(events.at(-1)).toMatchObject({ type: 'done', reason: 'interrupted' });
  });

  it('never goes past `maxTurns`: the loss fails the run with its error instead', async () => {
    const { model, requests } = provider(cutThenFinish({ kept: [piece('par')] }));
    const outcome = await run(model, { maxTurns: 1 });

    expectFailedWithLostConnection(outcome);
    expect(requests).toHaveLength(1);
  });

  it('spends none of the output limit’s allowance, even one set to zero', async () => {
    const { model } = provider(cutThenFinish({ kept: [piece('par')] }));
    const { events, failure } = await run(model, { maxOutputContinuations: 0 });

    expect(failure).toBeUndefined();
    expect(events.at(-1)).toMatchObject({ type: 'done', reason: 'completed' });
  });

  const reasoningOnly: StreamEvent = {
    type: 'reasoning',
    item: { source: 'test:model', data: { opaque: 'x' } },
  };

  it.each([
    ['nothing at all', []],
    ['only its reasoning, which a provider would not take back alone', [reasoningOnly]],
  ])('leaves no reply in history for a cut that kept %s', async (_name, kept) => {
    const { model } = provider(cutThenFinish({ kept, tail: 'hi' }));
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

  it('keeps going while each lost reply kept something, up to five calls in a row', async () => {
    const { model, requests } = provider([...losing(5), { events: [piece('end'), done] }]);
    const { failure, history } = await run(model);

    expect(failure).toBeUndefined();
    expect(requests).toHaveLength(6);
    expect(history.filter((message) => message.role === 'assistant')).toHaveLength(6);
  });

  it.each([
    ['nothing kept', Array.from({ length: 10 }, (): Step => ({ events: [], drops: true }))],
    ['a word kept each time', [...losing(8), { events: [done] }]],
  ])('fails the run with the error at the sixth in a row, with %s', async (_name, steps) => {
    const { model, requests } = provider(steps);

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

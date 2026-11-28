import { afterEach, describe, expect, it } from 'vitest';
import { ConnectionLostError } from '@sheavly/core/errors/connection.errors';
import type { PublishedItem } from '@sheavly/runtime/sessions/sessions.types';
import { until } from '@sheavly/testing/wait/until.fake';
import { cancelOpenFlows, startFlow, userPrompt } from '../../testing/flow.fake.js';
import { END_TURN, TOOL_USE } from '../../testing/item-chunks.constants.js';
import {
  completedItems,
  describeItems,
  eventsOf,
  expectItemsBeforeDone,
  expectValidItems,
  gatedCall,
  gatedTool,
  piece,
  runItems,
  scriptedCalls,
  splitToolEnds,
  workKind,
} from '../../testing/items.fake.js';
import { INTERRUPTED_BY_USER, STOPPED_BY_FAILURE } from '../stream-agent.constants.js';
import { runSession } from '../stream-agent.helper.js';

afterEach(cancelOpenFlows);

/** The `callId` of each tool item among `items`, in the order the items completed. */
const completedCallIds = (items: readonly PublishedItem[]) =>
  completedItems(eventsOf(items)).flatMap((item) =>
    item.kind === 'tool_call' ? [item.callId] : [],
  );

/**
 * A prompt whose first model call starts one piece of work of the kind called `name`, in a flow of
 * its own, with a listener for the items of every session in it. The work finishes at once, so a
 * third call may come to read its notice.
 */
async function runWork(name: string) {
  const kind = workKind(name);
  const flow = startFlow(kind);
  const heard: PublishedItem[] = [];

  flow.sessions.subscribeItems((item) => heard.push(item));
  await runSession({
    ...flow.options,
    provider: scriptedCalls([
      { chunks: kind.start({ speed: 'quick', id: 'c1' }) },
      { chunks: [piece('Started.'), END_TURN] },
      { chunks: [piece('Saw it.'), END_TURN] },
    ]),
    messages: userPrompt(),
  });

  return { flow, heard };
}

describe('items of a reply that was stopped', () => {
  it('(e) a stream cut by the user: the message completes interrupted with its partial text, and a started tool with the placeholder', async () => {
    const controller = new AbortController();
    const gated = gatedTool(['c1']);
    const result = await runItems({
      provider: scriptedCalls([{ chunks: [gatedCall('c1'), piece('par')], ends: 'hangs' }]),
      tools: [gated.tool],
      signal: controller.signal,
      onEvent: (event) => {
        if (event.type === 'text_delta') controller.abort();
      },
    });
    const items = completedItems(eventsOf(result.items));

    expect([...describeItems(eventsOf(result.items))].sort()).toEqual([
      'end message1 interrupted "par"',
      'end tool_call1 interrupted',
      'message1 @0 "par"',
      'start message1',
      'start tool_call1 gated',
    ]);
    expect(items.find((item) => item.kind === 'tool_call')).toMatchObject({
      reason: 'interrupted',
      result: { content: INTERRUPTED_BY_USER, isError: true },
    });
    expect(result.events.at(-1)).toMatchObject({ type: 'done', reason: 'interrupted' });
    expectItemsBeforeDone(result);
    expectValidItems(eventsOf(result.items));
  });

  it('(f) a provider error mid-reply: the message and the tools it started complete failed, before the run’s done', async () => {
    const gated = gatedTool(['c1']);
    const result = await runItems({
      provider: scriptedCalls([
        {
          chunks: [gatedCall('c1'), piece('half')],
          ends: { throws: new Error('the model refused') },
        },
      ]),
      tools: [gated.tool],
    });
    const items = completedItems(eventsOf(result.items));

    expect(result.failure).toMatchObject({ message: 'the model refused' });
    expect([...describeItems(eventsOf(result.items))].sort()).toEqual([
      'end message1 failed "half"',
      'end tool_call1 failed',
      'message1 @0 "half"',
      'start message1',
      'start tool_call1 gated',
    ]);
    expect(items.find((item) => item.kind === 'tool_call')).toMatchObject({
      reason: 'failed',
      result: { content: STOPPED_BY_FAILURE, isError: true },
    });
    expect(result.events.at(-1)).toMatchObject({ type: 'done', reason: 'failed' });
    expectItemsBeforeDone(result);
    expectValidItems(eventsOf(result.items));
  });

  it('(g) a lost connection: the message completes interrupted, the tool keeps running, and the turn that goes on makes new items', async () => {
    const gated = gatedTool(['c1']);
    const lost = new ConnectionLostError({ reason: 'dropped', message: 'dropped' });
    const result = await runItems({
      provider: scriptedCalls([
        { chunks: [gatedCall('c1'), piece('par')], ends: { throws: lost } },
        { chunks: [piece('tail'), END_TURN] },
      ]),
      tools: [gated.tool],
      // The turn that was cut released its results only now: the tool was still running.
      onEvent: (event) => {
        if (event.type === 'tool_batch') gated.open('c1');
      },
    });
    const { toolEnds, rest } = splitToolEnds(describeItems(eventsOf(result.items)));
    const started = eventsOf(result.items).flatMap((event) =>
      event.type === 'item_started' ? [event.itemId] : [],
    );

    expect(rest).toEqual([
      'start tool_call1 gated',
      'start message1',
      'message1 @0 "par"',
      'end message1 interrupted "par"',
      'start message2',
      'message2 @0 "tail"',
      'end message2 completed "tail"',
    ]);
    expect(toolEnds).toEqual(['end tool_call1 completed']);
    expect(
      completedItems(eventsOf(result.items)).find((item) => item.kind === 'tool_call'),
    ).toMatchObject({ result: { content: 'done c1', isError: false } });
    expect(new Set(started).size).toBe(started.length);
    expect(result.failure).toBeUndefined();
    expectItemsBeforeDone(result);
  });
});

describe('items of a call the context window did not fit', () => {
  it('(l) completes the message failed, since the model ended the call with context_window_exceeded and the loop may drop the reply', async () => {
    const result = await runItems({
      provider: scriptedCalls([
        {
          chunks: [piece('partial'), { type: 'done', stopReason: 'context_window_exceeded' }],
        },
      ]),
    });

    expect(describeItems(eventsOf(result.items))).toEqual([
      'start message1',
      'message1 @0 "partial"',
      'end message1 failed "partial"',
    ]);
    expect(result.events.at(-1)).toMatchObject({ type: 'done', reason: 'context_window_exceeded' });
    expectItemsBeforeDone(result);
    expectValidItems(eventsOf(result.items));
  });
});

describe('items of tools', () => {
  it('(i) parallel tools: each item completes when its own tool settles, in finish order, one of them before the turn ends', async () => {
    const gated = gatedTool(['a', 'b', 'c']);
    const modelWait = Promise.withResolvers<undefined>();
    const seen: PublishedItem[] = [];
    const finished = runItems({
      provider: scriptedCalls([
        {
          chunks: [gatedCall('a'), gatedCall('b'), gatedCall('c')],
          after: { wait: modelWait.promise, chunks: [TOOL_USE] },
        },
        { chunks: [END_TURN] },
      ]),
      tools: [gated.tool],
      onItem: (item) => seen.push(item),
    });

    // `b` settles while the model is still streaming, `c` and then `a` after the turn is over.
    gated.open('b');
    await until(() => completedCallIds(seen).length === 1);
    modelWait.resolve(undefined);
    gated.open('c');
    await until(() => completedCallIds(seen).length === 2);
    gated.open('a');

    const result = await finished;

    expect(completedCallIds(result.items)).toEqual(['b', 'c', 'a']);
    expect(result.log.indexOf('item:item_completed')).toBeLessThan(
      result.log.indexOf('event:turn_end'),
    );
    expectItemsBeforeDone(result);
    expectValidItems(eventsOf(result.items));
  });

  it('(h) a tool that launched a node: its item holds the task and the node, and no result', async () => {
    const { heard } = await runWork('background command (task)');
    const tool = completedItems(eventsOf(heard)).find((item) => item.kind === 'tool_call');

    expect(tool).toMatchObject({ reason: 'completed', callId: 'c1', turn: 1 });
    expect(tool).toHaveProperty('task.info.id');
    expect(typeof (tool?.kind === 'tool_call' ? tool.task?.nodeId : undefined)).toBe('string');
    expect(tool).not.toHaveProperty('result');
    expectValidItems(eventsOf(heard));
  });

  it('(k) a sub-agent’s run publishes its items under its own session id', async () => {
    const { flow, heard } = await runWork('sub-agent');

    await until(() =>
      heard.some(
        ({ sessionId, event }) => sessionId !== flow.ref.id && event.type === 'item_completed',
      ),
    );

    // The sub-agent's session may be released by now, once its report is delivered.
    const childId = heard.find((item) => item.sessionId !== flow.ref.id)?.sessionId;
    const own = (sessionId: string | undefined) =>
      eventsOf(heard.filter((item) => item.sessionId === sessionId));

    expect(childId).toBeDefined();
    expect(describeItems(own(childId))).toEqual([
      'start message1',
      'message1 @0 "child report"',
      'end message1 completed "child report"',
    ]);
    expect(describeItems(own(flow.ref.id))).toContain('start message1');
    expect(describeItems(own(flow.ref.id))).toContain('start tool_call1 start_agent');
    expectValidItems(eventsOf(heard));
  });
});

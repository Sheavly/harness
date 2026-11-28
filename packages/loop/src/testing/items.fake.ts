import { expect } from 'vitest';
import { z } from 'zod';
import type { StreamEvent } from '@sheavly/core/message/message.types';
import type { Provider } from '@sheavly/core/provider/provider.types';
import type { Tool } from '@sheavly/core/tool/tool.types';
import { defineTool } from '@sheavly/core/tool/tool.utils';
import type { AgentEvent } from '@sheavly/protocol/event/event.types';
import type { Item, ItemEvent } from '@sheavly/protocol/item/item.types';
import { itemEventSchema, itemSchema } from '@sheavly/protocol/item/item.validator';
import { callIdSchema } from '@sheavly/protocol/message/message.validator';
import { SessionRegistry } from '@sheavly/runtime/sessions/sessions.service';
import type { PublishedItem } from '@sheavly/runtime/sessions/sessions.types';
import { streamAgent } from '../stream-agent/stream-agent.helper.js';
import type { ItemRun, ScriptedCall } from './item-run.types.js';
import { WORK_KINDS } from './work-kinds.fake.js';
import type { WorkKind } from './work-kinds.types.js';

/** A provider that plays `calls` in turn, one for each model call. */
export function scriptedCalls(calls: ScriptedCall[]): Provider {
  let index = 0;

  return {
    async *stream({ signal }) {
      const call = calls[index++];

      if (!call) throw new Error('scriptedCalls ran out of calls');

      yield* call.chunks;

      if (call.after) {
        await call.after.wait;
        yield* call.after.chunks;
      }

      if (call.ends === 'hangs') {
        await new Promise((resolve) =>
          signal.addEventListener('abort', () => resolve(undefined), { once: true }),
        );
      } else if (call.ends) {
        throw call.ends.throws;
      }
    },
  };
}

export const piece = (text: string): StreamEvent => ({ type: 'text_delta', text });

export const activity = (active: boolean): StreamEvent => ({ type: 'reasoning_activity', active });

/** A call of the `gated` tool, which the model makes by `id`. */
export const gatedCall = (id: string): StreamEvent => ({
  type: 'tool_call',
  call: {
    id: callIdSchema.parse(id),
    name: 'gated',
    input: { description: `task ${id}`, id },
  },
});

/** A tool that returns when the test opens its call's gate, and ignores any stop until then. */
export function gatedTool(ids: string[]) {
  const gates = new Map(ids.map((id) => [id, Promise.withResolvers<undefined>()]));
  const tool = defineTool({
    name: 'gated',
    description: 'Returns once its gate is open',
    inputSchema: z.object({ id: z.string() }),
    execute: async ({ input }) => {
      await gates.get(input.id)?.promise;

      return `done ${input.id}`;
    },
  });

  return { tool, open: (id: string) => gates.get(id)?.resolve(undefined) };
}

/**
 * Runs the loop in a real registry, with or without a listener for items (`listen`), and returns
 * what it left. A failed run's error is in `failure`, not thrown. `onEvent` sees each event as the
 * consumer gets it.
 */
export async function runItems(params: {
  provider: Provider;
  tools?: Tool[];
  signal?: AbortSignal;
  listen?: boolean;
  onEvent?: (event: AgentEvent) => void;
  onItem?: (item: PublishedItem) => void;
}): Promise<ItemRun> {
  const { provider, tools = [], signal, listen = true, onEvent, onItem } = params;
  const sessions = new SessionRegistry();
  const ref = sessions.startMain({ title: 'Main' });
  const run: ItemRun = {
    events: [],
    entries: [],
    items: [],
    log: [],
    failure: undefined,
    sessions,
  };

  sessions.subscribeEntries((entry) => run.entries.push(entry));

  if (listen) {
    sessions.subscribeItems((item) => {
      run.items.push(item);
      run.log.push(`item:${item.event.type}`);
      onItem?.(item);
    });
  }

  try {
    for await (const event of streamAgent({
      provider,
      tools,
      messages: [{ role: 'user', content: 'go' }],
      session: { registry: sessions, ref },
      ...(signal && { signal }),
    })) {
      run.events.push(event);
      run.log.push(`event:${event.type}`);
      onEvent?.(event);
    }
  } catch (caughtError) {
    run.failure = caughtError;
  }

  return run;
}

/** The kind of work of the table `WORK_KINDS` called `name`. */
export function workKind(name: string): WorkKind {
  const kind = WORK_KINDS.find((candidate) => candidate.name === name);

  if (!kind) throw new Error(`no work kind named ${name}`);

  return kind;
}

/** The events of published items, without who they were told for. */
export function eventsOf(items: readonly PublishedItem[]): ItemEvent[] {
  return items.map(({ event }) => event);
}

/** The completed items among `events`, in the order they completed. */
export function completedItems(events: readonly ItemEvent[]): Item[] {
  return events.flatMap((event) => (event.type === 'item_completed' ? [event.item] : []));
}

/**
 * One line for each item event, with stable names for the ids (`message1`, `tool_call1`: each
 * kind counted from 1 in the order it started): `start message1`, `message1 @0 "text"` for a
 * delta and its offset, `end message1 completed "text"`.
 */
export function describeItems(events: readonly ItemEvent[]): string[] {
  const names = new Map<string, string>();
  const counts = new Map<string, number>();
  const nameOf = (id: string) => names.get(id) ?? id;

  return events.map((event) => {
    if (event.type === 'item_delta') {
      return `${nameOf(event.itemId)} @${String(event.offset)} ${JSON.stringify(event.text)}`;
    }

    if (event.type === 'item_started') {
      const count = (counts.get(event.kind) ?? 0) + 1;

      counts.set(event.kind, count);
      names.set(event.itemId, `${event.kind}${String(count)}`);

      return `start ${nameOf(event.itemId)}${event.kind === 'tool_call' ? ` ${event.name}` : ''}`;
    }

    const { item } = event;

    return `end ${nameOf(item.id)} ${item.reason}${
      item.kind === 'message' ? ` ${JSON.stringify(item.text)}` : ''
    }`;
  });
}

/**
 * `describeItems` lines in two lists: the ends of tool items, and the rest. A tool's end comes
 * when its tool settles, which the chunks after its call do not wait for, so it is not placed
 * among them.
 */
export function splitToolEnds(lines: readonly string[]) {
  const isToolEnd = (line: string) => line.startsWith('end tool_call');

  return { toolEnds: lines.filter(isToolEnd), rest: lines.filter((line) => !isToolEnd(line)) };
}

/** The run's `done` reached its consumer after every item was told, and nothing came after it. */
export function expectItemsBeforeDone(run: ItemRun): void {
  const done = run.log.indexOf('event:done');

  expect(done).toBeGreaterThan(-1);
  expect(run.log.slice(done).filter((line) => line.startsWith('item:'))).toEqual([]);
}

/** Every event parses as an item event, and every completed item as an item. */
export function expectValidItems(events: readonly ItemEvent[]): void {
  for (const event of events) {
    expect(itemEventSchema.safeParse(event).success).toBe(true);
  }

  for (const item of completedItems(events)) {
    expect(itemSchema.safeParse(item).success).toBe(true);
  }
}

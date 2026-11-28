import { Hono } from 'hono';
import { describe, expect, it } from 'vitest';
import type { SubscribeFrame } from '@sheavly/protocol/subscription/subscription.types';
import { subscribeFrameSchema } from '@sheavly/protocol/subscription/subscription.validator';
import { streamSubscription } from '../subscription-stream.helper.js';

const CHANNEL = 'agent-1';
const ITEM = '3f1b2c4d-5e6f-4a7b-8c9d-0e1f2a3b4c5d';

const live = subscribeFrameSchema.parse({
  type: 'live',
  channel: CHANNEL,
  event: { type: 'item_delta', itemId: ITEM, offset: 0, text: 'Hello' },
});
const closed = subscribeFrameSchema.parse({
  channel: CHANNEL,
  cursor: 's2',
  at: 3,
  type: 'closed',
  state: 'completed',
  outcome: 'completed',
});
const head = subscribeFrameSchema.parse({ type: 'head', channel: CHANNEL, cursor: 's1' });

/** The server-sent events a subscription of `frames` writes, as text. */
async function written(frames: SubscribeFrame[]) {
  const app = new Hono();
  const source = {
    async *frames() {
      await Promise.resolve();
      yield* frames;
    },
    close: () => undefined,
  };

  app.get('/', (c) => streamSubscription({ c, subscription: source }));

  return (await app.request('/')).text();
}

/** One server-sent event of `text` per frame: its lines. */
const eventsOf = (text: string) =>
  text
    .split('\n\n')
    .filter((each) => each !== '')
    .map((each) => each.split('\n'));

describe('a subscription’s frames as server-sent events', () => {
  it('writes a live frame as the `live` event with its JSON as data, and no id', async () => {
    const [event] = eventsOf(await written([live]));

    expect(event).toEqual(['event: live', `data: ${JSON.stringify(live)}`]);
  });

  it('names the other frames as before, entries `entry`, and writes none with an id', async () => {
    const events = eventsOf(await written([head, live, closed]));

    expect(events.map(([name]) => name)).toEqual(['event: head', 'event: live', 'event: entry']);
    expect(events.flat().filter((line) => line.startsWith('id:'))).toEqual([]);
  });
});

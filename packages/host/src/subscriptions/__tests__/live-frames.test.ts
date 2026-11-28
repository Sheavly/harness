import { describe, expect, it } from 'vitest';
import type { SubscribeFrame } from '@sheavly/protocol/subscription/subscription.types';
import { subscribeFrameSchema } from '@sheavly/protocol/subscription/subscription.validator';
import { FrameQueue } from '../frame-queue.service.js';
import { bytesOfFrame, cursorOfFrame } from '../subscription-frames.utils.js';

const CHANNEL = 'agent-1';
const ITEM = '3f1b2c4d-5e6f-4a7b-8c9d-0e1f2a3b4c5d';

const head = subscribeFrameSchema.parse({ type: 'head', channel: CHANNEL, cursor: 's1' });

const live = subscribeFrameSchema.parse({
  type: 'live',
  channel: CHANNEL,
  event: { type: 'item_delta', itemId: ITEM, offset: 0, text: 'Hello' },
});

const updated = subscribeFrameSchema.parse({
  channel: CHANNEL,
  cursor: 's4',
  at: 1,
  type: 'updated',
  node: { kind: 'agent', id: CHANNEL, title: 'Main', state: 'running', startedAt: 1 },
});

/** A frame waiting for the consumer, counted as the subscription counts it. */
const waiting = (frame: SubscribeFrame) => ({
  frame,
  channel: CHANNEL,
  live: true,
  bytes: bytesOfFrame(frame),
});

describe('a live frame in a subscription', () => {
  it('counts its JSON against the held bytes, as an entry does, and the control frames count none', () => {
    expect(bytesOfFrame(live)).toBe(JSON.stringify(live).length);
    expect(bytesOfFrame(live)).toBeGreaterThan(0);
    expect(bytesOfFrame(head)).toBe(0);
  });

  it('carries no cursor', () => {
    expect(cursorOfFrame(live)).toBeUndefined();
    expect(cursorOfFrame(updated)).toBe('s4');
  });

  it('is passed over when the queue says where a channel resumes: the newest frame with a cursor', () => {
    const queue = new FrameQueue();

    queue.push(waiting(updated));
    queue.push(waiting(live));
    queue.push(waiting(live));

    expect(queue.lastCursor(CHANNEL)).toBe('s4');
  });

  it('leaves a channel with only live frames waiting with no cursor to resume from', () => {
    const queue = new FrameQueue();

    queue.push(waiting(live));

    expect(queue.lastCursor(CHANNEL)).toBeUndefined();
  });

  it('is a live frame of the queue like another: counted for its channel and dropped with it', () => {
    const queue = new FrameQueue();

    queue.push(waiting(live));
    queue.push(waiting(updated));

    expect(queue.liveQueued(CHANNEL)).toBe(2);
    expect(queue.dropLive(CHANNEL)).toBe(bytesOfFrame(live) + bytesOfFrame(updated));
  });
});

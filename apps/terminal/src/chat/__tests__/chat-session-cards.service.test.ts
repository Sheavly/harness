import { describe, expect, it } from 'vitest';
import type { ChatItem } from '../../client/transcript.types.js';
import { hearAll, recordingChat } from '../testing/chat-session.fake.js';
import { messageIdOf } from '../testing/feed-items.fake.js';

const STARTED = '"Helper" [worker] started';

/** A chat, and the card of the sub-agent `Helper`, which the main agent starts with the call c1. */
function scene() {
  const chat = recordingChat();
  const { items } = chat;

  return {
    ...chat,
    helper: (change: 'started' | 'ended') =>
      items.card(change, {
        node: 'worker',
        title: 'Helper',
        spawnedBy: 'c1',
        ...(change === 'ended' && { state: 'completed' as const, outcome: 'completed' as const }),
      }),
    run: items.prompt({ messageId: messageIdOf(1), text: 'go' }),
    hear: (...heard: ChatItem[]) => hearAll({ session: chat.session, items: heard }),
  };
}

describe('ChatSession: a sub-agent’s card stands where the main agent calls its tool', () => {
  it('draws a card held for its call right after the call, and not before', () => {
    const { output, items, helper, run, hear } = scene();

    hear(run, helper('started'));
    expect(output()).not.toContain('Helper');

    hear(items.toolStarted('c1', 'Start a helper'));

    expect(output().indexOf('Start a helper')).toBeGreaterThanOrEqual(0);
    expect(output().indexOf(STARTED)).toBeGreaterThan(output().indexOf('Start a helper'));
  });

  it('draws a card with no call, or whose call was shown, at once', () => {
    const { output, items, hear } = scene();

    hear(
      items.toolStarted('c1', 'Start a helper'),
      items.card('started', { node: 'late', title: 'Late', spawnedBy: 'c1' }),
      items.card('started', { node: 'free', title: 'Free' }),
    );

    expect(output()).toContain('"Late"');
    expect(output()).toContain('"Free"');
  });

  it('draws the cards still held before the run’s done, so they are in the run', () => {
    const { output, items, helper, run, hear } = scene();

    hear(run, helper('started'), helper('ended'), items.done());

    expect(output().indexOf(STARTED)).toBeGreaterThanOrEqual(0);
    expect(output().indexOf(STARTED)).toBeLessThan(output().indexOf('[completed'));
    expect(output()).toContain('"Helper" [worker] completed');
  });

  it('draws the cards still held when the feed is lost, so none waits for ever', () => {
    const { session, output, helper, run, hear } = scene();

    hear(run, helper('started'));
    session.lostFeed(new Error('gone'));

    expect(output()).toContain(STARTED);
  });

  it('draws the cards still held when the next run starts over a lost done', () => {
    const { output, items, helper, run, hear } = scene();

    hear(run, helper('started'), items.wake(messageIdOf(1)));

    expect(output()).toContain(STARTED);
  });
});

describe('ChatSession: an event too large to store', () => {
  it('draws a line for it, and lets the card of its call go', () => {
    const { output, items, helper, hear } = scene();

    hear(helper('started'), items.omitted({ eventType: 'tool_result', call: 'c1' }));

    expect(output()).toContain('the result of run_command was too large to store');
    expect(output()).toContain(STARTED);
  });
});

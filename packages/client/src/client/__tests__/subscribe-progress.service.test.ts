import { describe, expect, it } from 'vitest';
import type { SubscribeRequest } from '@sheavly/protocol/subscription/subscription.types';
import {
  agentOpened,
  agentUpdated,
  channelOf,
  commandClosed,
  endedAs,
  headAt,
  outputText,
} from '../../testing/frames.fake.js';
import { SubscribeProgress } from '../subscribe-progress.service.js';

const subscriptions = (...list: [string, string][]): SubscribeRequest['subscriptions'] =>
  list.map(([channel, from]) => ({ channel: channelOf(channel), from }));

describe('SubscribeProgress: what a reconnect asks for', () => {
  it('asks each channel from where it was first asked, and then from the cursor of its last frame', () => {
    const progress = new SubscribeProgress(subscriptions(['a', 'start'], ['b', 'now']));

    expect(progress.nextRequest()).toEqual([
      { channel: 'a', from: 'start' },
      { channel: 'b', from: 'now' },
    ]);

    progress.accept(agentOpened('a'));
    progress.accept(agentUpdated({ name: 'a', n: 1 }));

    // `b` had no frame, so it is asked again as it was.
    expect(progress.nextRequest()).toEqual([
      { channel: 'a', from: 's1' },
      { channel: 'b', from: 'now' },
    ]);
  });

  it('does not ask for a channel that ended, whichever way it ended', () => {
    const progress = new SubscribeProgress(
      subscriptions(['a', 'start'], ['b', 'start'], ['c', 'start']),
    );

    progress.accept(endedAs({ name: 'a', reason: 'completed' }));
    progress.accept(endedAs({ name: 'b', reason: 'failed' }));

    expect(progress.nextRequest()).toEqual([{ channel: 'c', from: 'start' }]);
    expect(progress.finished).toBe(false);

    progress.accept(endedAs({ name: 'c', reason: 'completed' }));
    expect(progress.finished).toBe(true);
  });

  it('takes the cursor of a head frame, so a drop before any entry resumes after it', () => {
    const progress = new SubscribeProgress(subscriptions(['a', 'now']));

    progress.accept(headAt({ name: 'a', cursor: 's7' }));

    expect(progress.nextRequest()).toEqual([{ channel: 'a', from: 's7' }]);
  });
});

describe('SubscribeProgress: which frames the reader sees', () => {
  it('gives a frame once: one at or before the last cursor of its channel is dropped', () => {
    const progress = new SubscribeProgress(subscriptions(['a', 'start']));
    const first = agentUpdated({ name: 'a', n: 2 });

    expect(progress.accept(first)).toBe(first);
    expect(progress.accept(first)).toBeUndefined();
    expect(progress.accept(agentUpdated({ name: 'a', n: 1 }))).toBeUndefined();
    expect(progress.accept(agentUpdated({ name: 'a', n: 3 }))).toBeDefined();
  });

  it('keeps each channel’s cursor apart, and ignores a frame of a channel it did not ask for', () => {
    const progress = new SubscribeProgress(subscriptions(['a', 'start'], ['b', 'start']));

    progress.accept(agentUpdated({ name: 'a', n: 5 }));

    expect(progress.accept(agentUpdated({ name: 'b', n: 1 }))).toBeDefined();
    expect(progress.accept(agentUpdated({ name: 'other', n: 1 }))).toBeUndefined();
  });

  it('gives the closed entry of a command’s channel, which has the cursor of the output before it, once', () => {
    const progress = new SubscribeProgress(subscriptions(['cmd', 'start']));
    const closed = commandClosed({ name: 'cmd', bytes: 5 });

    expect(progress.accept(outputText({ name: 'cmd', offset: 0, text: 'hello' }))).toBeDefined();
    // The same cursor, and still new: it is not output.
    expect(progress.accept(closed)).toBe(closed);
    expect(progress.accept(closed)).toBeUndefined();
    // An output chunk at that cursor is a repeat, as on any channel.
    expect(progress.accept(outputText({ name: 'cmd', offset: 0, text: 'hello' }))).toBeUndefined();
  });

  it('gives a closed entry the server sends again after a resume only if it was never delivered', () => {
    const resumed = new SubscribeProgress(subscriptions(['cmd', 'start']));

    resumed.accept(outputText({ name: 'cmd', offset: 0, text: 'hello' }));

    // Resumed after the output, with the close still to come.
    expect(resumed.accept(commandClosed({ name: 'cmd', bytes: 5 }))).toBeDefined();
  });
});

describe('SubscribeProgress: a channel the server cut off', () => {
  it('is not shown to the reader, says the connection is to be left, and is asked from the cursor in the frame', () => {
    const progress = new SubscribeProgress(subscriptions(['a', 'start'], ['b', 'start']));

    progress.accept(agentUpdated({ name: 'a', n: 1 }));

    expect(
      progress.accept(endedAs({ name: 'a', reason: 'cut_off', cursor: 's4' })),
    ).toBeUndefined();
    expect(progress.cutOff).toBe(true);
    expect(progress.finished).toBe(false);

    // The next connection asks for it again, and clears the mark.
    expect(progress.nextRequest()).toEqual([
      { channel: 'a', from: 's4' },
      { channel: 'b', from: 'start' },
    ]);
    expect(progress.cutOff).toBe(false);
  });

  it('is not asked from a cursor behind what was delivered: a cut-off only moves a channel forward', () => {
    const progress = new SubscribeProgress(subscriptions(['a', 'start']));

    progress.accept(agentUpdated({ name: 'a', n: 6 }));
    progress.accept(endedAs({ name: 'a', reason: 'cut_off', cursor: 's2' }));

    expect(progress.nextRequest()).toEqual([{ channel: 'a', from: 's6' }]);
  });
});

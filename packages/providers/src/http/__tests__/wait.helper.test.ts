import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useFixedClock } from '@sheavly/testing/clock/fixed-clock.fake';
import { waitAwake } from '../wait.helper.js';

describe('waiting while awake', () => {
  const clock = useFixedClock();

  beforeEach(() => {
    // Only timers: the clock itself is `useFixedClock`'s, so a test decides how much time "passed".
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('waits the whole time and counts it when the machine stays awake', async () => {
    const waiting = waitAwake({ ms: 2500, signal: new AbortController().signal });

    for (let slice = 0; slice < 3; slice++) {
      clock.advance(slice < 2 ? 1000 : 500);
      await vi.advanceTimersByTimeAsync(slice < 2 ? 1000 : 500);
    }

    await expect(waiting).resolves.toEqual({ awakeMs: 2500, slept: false });
  });

  it('ends at the first slice that ran long because the machine slept, not after what was left', async () => {
    const waiting = waitAwake({ ms: 30_000, signal: new AbortController().signal });

    clock.advance(8 * 3_600_000);
    await vi.advanceTimersByTimeAsync(1000);

    await expect(waiting).resolves.toEqual({ awakeMs: 1000, slept: true });
  });

  it('rejects with the reason the signal aborted with', async () => {
    const controller = new AbortController();
    const waiting = waitAwake({ ms: 30_000, signal: controller.signal });
    const outcome = waiting.catch((caughtError: unknown) => caughtError);

    controller.abort(new Error('stop'));

    expect(await outcome).toMatchObject({ message: 'stop' });
  });
});

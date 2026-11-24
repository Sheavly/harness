import { describe, expect, it } from 'vitest';
import { awakeTime, describeWait, isLoopbackHost } from '../outage.utils.js';

describe('a loopback host', () => {
  it.each(['localhost', 'LOCALHOST', '127.0.0.1', '127.1.2.3', '[::1]', '::1'])('is %s', (host) => {
    expect(isLoopbackHost(host)).toBe(true);
  });

  it.each(['api.openai.com', '10.0.0.5', '192.168.1.2', 'localhost.example.com', '1127.0.0.1'])(
    'is not %s',
    (host) => {
      expect(isLoopbackHost(host)).toBe(false);
    },
  );
});

describe('the time a step spent awake', () => {
  it('is all of it when it took about as long as expected', () => {
    expect(awakeTime({ elapsedMs: 800, expectedMs: 1000 })).toEqual({ awakeMs: 800, slept: false });
    expect(awakeTime({ elapsedMs: 5900, expectedMs: 1000 })).toEqual({
      awakeMs: 5900,
      slept: false,
    });
  });

  it('is only what was expected when the step ran long enough to have been slept through', () => {
    expect(awakeTime({ elapsedMs: 6100, expectedMs: 1000 })).toEqual({
      awakeMs: 1000,
      slept: true,
    });
    expect(awakeTime({ elapsedMs: 36_000_000, expectedMs: 1000 })).toEqual({
      awakeMs: 1000,
      slept: true,
    });
  });

  it('is never negative when the clock was set back', () => {
    expect(awakeTime({ elapsedMs: -50, expectedMs: 1000 })).toEqual({ awakeMs: 0, slept: false });
  });
});

describe('how a wait is described', () => {
  it('uses seconds under a minute and minutes after', () => {
    expect(describeWait(12_000)).toBe('12s');
    expect(describeWait(60_000)).toBe('1 min');
    expect(describeWait(3_600_000)).toBe('60 min');
  });
});

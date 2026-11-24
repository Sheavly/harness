import { describe, expect, it } from 'vitest';
import { DateTime } from 'luxon';
import { useFixedClock } from '@sheavly/testing/clock/fixed-clock.fake';
import {
  backoffMs,
  isRetryableStatus,
  isWorthWaiting,
  offlineBackoffMs,
  retryAfterMs,
} from '../retry-policy.helper.js';

const clock = useFixedClock(DateTime.utc(2026, 10, 21, 7, 28).toMillis());

describe('isRetryableStatus', () => {
  it.each([429, 500, 503, 529])('retries %i', (status) => {
    expect(isRetryableStatus(status)).toBe(true);
  });

  it.each([200, 400, 401, 404, 422])('does not retry %i', (status) => {
    expect(isRetryableStatus(status)).toBe(false);
  });
});

/** The response headers of a server that asked to wait `value`. */
const asking = (value: string) => new Headers({ 'retry-after': value });

describe('retryAfterMs', () => {
  it('reads delta-seconds', () => {
    expect(retryAfterMs(asking('2'))).toBe(2000);
    expect(retryAfterMs(asking('0.05'))).toBe(50);
  });

  it('reads an HTTP date relative to now', () => {
    expect(retryAfterMs(asking('Wed, 21 Oct 2026 07:28:30 GMT'))).toBe(30_000);
    clock.advance(10_000);
    expect(retryAfterMs(asking('Wed, 21 Oct 2026 07:28:30 GMT'))).toBe(20_000);
  });

  it('is 0 for a date already past, a missing header or an unusable one', () => {
    expect(retryAfterMs(asking('Wed, 21 Oct 2026 07:20:00 GMT'))).toBe(0);
    expect(retryAfterMs(new Headers())).toBe(0);
    expect(retryAfterMs(asking(' '))).toBe(0);
    expect(retryAfterMs(asking('soon'))).toBe(0);
    expect(retryAfterMs(asking('-5'))).toBe(0);
  });
});

describe('isWorthWaiting', () => {
  it('waits for up to a minute and reports a longer ask instead', () => {
    expect(isWorthWaiting(60_000)).toBe(true);
    expect(isWorthWaiting(60_001)).toBe(false);
  });
});

describe('backoffMs', () => {
  const base = { retryDelayMs: 1000, serverWaitMs: 0 };

  it('doubles per attempt, cut to between half and all of the ceiling', () => {
    expect(backoffMs({ ...base, tried: 0, random: () => 0 })).toBe(500);
    expect(backoffMs({ ...base, tried: 0, random: () => 0.999 })).toBeCloseTo(999.5);
    expect(backoffMs({ ...base, tried: 2, random: () => 0 })).toBe(2000);
    expect(backoffMs({ ...base, tried: 2, random: () => 0.5 })).toBe(3000);
  });

  it('is never less than what the server asked for', () => {
    expect(backoffMs({ ...base, tried: 0, serverWaitMs: 5000, random: () => 0 })).toBe(5000);
  });

  it('is 0 with no delay configured and no server ask', () => {
    expect(backoffMs({ retryDelayMs: 0, serverWaitMs: 0, tried: 3, random: () => 0.7 })).toBe(0);
  });
});

describe('offlineBackoffMs', () => {
  const base = { retryDelayMs: 1000, random: () => 0.999 };

  it('doubles like any retry at first, from a second', () => {
    expect(offlineBackoffMs({ ...base, round: 0 })).toBe(1000);
    expect(offlineBackoffMs({ ...base, round: 3 })).toBeCloseTo(7996);
  });

  it('is never under a second, even with no retry delay configured', () => {
    expect(offlineBackoffMs({ retryDelayMs: 0, round: 0, random: () => 0 })).toBe(1000);
    expect(offlineBackoffMs({ retryDelayMs: 0, round: 5, random: () => 0.7 })).toBe(1000);
    expect(offlineBackoffMs({ retryDelayMs: 100, round: 1, random: () => 0 })).toBe(1000);
  });

  it('stops growing at 30 seconds, however many rounds have passed', () => {
    expect(offlineBackoffMs({ ...base, round: 6 })).toBe(30_000);
    expect(offlineBackoffMs({ ...base, round: 10_000 })).toBe(30_000);
    expect(offlineBackoffMs({ ...base, round: 10_000, random: () => 0 })).toBe(30_000);
  });
});

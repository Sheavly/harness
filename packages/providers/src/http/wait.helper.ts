import { now } from '@sheavly/core/clock/clock.helper';
import { WAKE_CHECK_MS } from './http.constants.js';
import { awakeTime } from './outage.utils.js';

/** Waits `ms`, or rejects as soon as `signal` aborts. */
export function wait(params: { ms: number; signal: AbortSignal }): Promise<void> {
  const { ms, signal } = params;

  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(signal.reason as Error);

      return;
    }

    const done = () => {
      signal.removeEventListener('abort', aborted);
      resolve();
    };
    const timer = setTimeout(done, ms);
    const aborted = () => {
      clearTimeout(timer);
      reject(signal.reason as Error);
    };

    signal.addEventListener('abort', aborted, { once: true });
  });
}

/**
 * Waits `ms` like `wait`, in slices of `WAKE_CHECK_MS`, and ends early once a slice ran long
 * because the machine slept (a connection that went away with it is worth asking for at once, not
 * after what was left of a delay). Returns the time that passed awake, and whether it slept.
 */
export async function waitAwake(params: {
  ms: number;
  signal: AbortSignal;
}): Promise<{ awakeMs: number; slept: boolean }> {
  const { ms, signal } = params;
  let awakeMs = 0;

  for (let planned = 0; planned < ms;) {
    const slice = Math.min(WAKE_CHECK_MS, ms - planned);
    const started = now();

    await wait({ ms: slice, signal });

    const step = awakeTime({ elapsedMs: now() - started, expectedMs: slice });

    awakeMs += step.awakeMs;

    if (step.slept) return { awakeMs, slept: true };

    planned += slice;
  }

  return { awakeMs, slept: false };
}

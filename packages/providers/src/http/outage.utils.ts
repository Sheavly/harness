import { LOCAL_HOST, MS_PER_MINUTE, MS_PER_SECOND, WAKE_GAP_MS } from './http.constants.js';

/**
 * Whether `hostname` (as a `URL` has it) is on this machine or its own network: a model served
 * there has no internet to lose, so its failure is its own and is never waited for.
 */
export function isLocalHost(hostname: string): boolean {
  return LOCAL_HOST.test(hostname);
}

/**
 * The time a step that should have taken at most `expectedMs` and took `elapsedMs` of the wall
 * clock actually spent awake. Timers stop while a machine sleeps and the wall clock does not, so a
 * step that ran `WAKE_GAP_MS` over was slept through: `slept` says so, and only `expectedMs` of it
 * counts.
 */
export function awakeTime(params: { elapsedMs: number; expectedMs: number }): {
  awakeMs: number;
  slept: boolean;
} {
  const { elapsedMs, expectedMs } = params;

  if (elapsedMs > expectedMs + WAKE_GAP_MS) return { awakeMs: expectedMs, slept: true };

  return { awakeMs: Math.max(0, elapsedMs), slept: false };
}

/** How long a lost connection has been waited for, as an error message says it. */
export function describeWait(ms: number): string {
  if (ms < MS_PER_MINUTE) return `${String(Math.round(ms / MS_PER_SECOND))}s`;

  return `${String(Math.round(ms / MS_PER_MINUTE))} min`;
}

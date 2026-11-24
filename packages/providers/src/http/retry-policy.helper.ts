import { httpDateMs, now } from '@sheavly/core/clock/clock.helper';
import {
  MAX_RETRY_AFTER_MS,
  MS_PER_SECOND,
  OFFLINE_MAX_BACKOFF_ROUNDS,
  OFFLINE_MAX_DELAY_MS,
} from './http.constants.js';

/**
 * The one retry policy of a model call. A call is retried only before its response headers
 * arrive: a request that never reached the server, one whose response did not start in time,
 * HTTP 429 and 5xx. A failure once the reply is streaming is never retried: the turn may have
 * started tools, so a repeat could run them twice, and the loop owns recovery from there.
 */
export function isRetryableStatus(status: number): boolean {
  return status === 429 || status >= 500;
}

/**
 * The server's `retry-after` in ms, in either form (delta-seconds or an HTTP date), or 0 when it
 * sent none, one that is unusable, or a date already past.
 */
export function retryAfterMs(headers: Headers): number {
  const value = headers.get('retry-after')?.trim();

  if (!value) return 0;

  const seconds = Number(value);

  if (Number.isFinite(seconds)) return seconds > 0 ? seconds * MS_PER_SECOND : 0;

  const date = httpDateMs(value);

  return date === undefined ? 0 : Math.max(0, date - now());
}

/** Whether a server's `retry-after` is short enough to wait for; a longer one is reported instead. */
export function isWorthWaiting(waitMs: number): boolean {
  return waitMs <= MAX_RETRY_AFTER_MS;
}

/**
 * How long to wait before the next attempt: `retryDelayMs` doubled per attempt already made, cut
 * to between half and all of it so clients that failed together do not retry together
 * (`random` returns a number in [0, 1)), and never less than the server's `retry-after`.
 */
export function backoffMs(params: {
  tried: number;
  retryDelayMs: number;
  serverWaitMs: number;
  random: () => number;
}): number {
  const ceiling = params.retryDelayMs * 2 ** params.tried;
  const jittered = ceiling / 2 + (ceiling / 2) * params.random();

  return Math.max(params.serverWaitMs, jittered);
}

/**
 * How long to wait before asking again while this machine has no connection: `backoffMs` with no
 * server to ask, its doubling stopped after `OFFLINE_MAX_BACKOFF_ROUNDS` and the whole cut to
 * `OFFLINE_MAX_DELAY_MS`, so a connection that is back is found within that, however long it was gone.
 */
export function offlineBackoffMs(params: {
  round: number;
  retryDelayMs: number;
  random: () => number;
}): number {
  const delay = backoffMs({
    tried: Math.min(params.round, OFFLINE_MAX_BACKOFF_ROUNDS),
    retryDelayMs: params.retryDelayMs,
    serverWaitMs: 0,
    random: params.random,
  });

  return Math.min(delay, OFFLINE_MAX_DELAY_MS);
}

import { now } from '@sheavly/core/clock/clock.helper';
import { providerErrorText } from '@sheavly/core/text/diagnostic-text.utils';
import { ModelApiError } from '../errors/providers.errors.js';
import { internetReachable } from './connectivity.helper.js';
import { PROBE_TIMEOUT_MS } from './http.constants.js';
import type { ConnectionReport, SendRequestParams, Standing } from './http.types.js';
import { awakeTime, describeWait, isLocalHost } from './outage.utils.js';
import { offlineBackoffMs } from './retry-policy.helper.js';
import { waitAwake } from './wait.helper.js';

/**
 * Whether a failed attempt is this machine having no connection, as opposed to the provider
 * failing. Only a request that did not get an HTTP answer can be: of those, one to this machine
 * or its own network can't, and neither can one when waiting is off or there is nothing to probe
 * with. The rest
 * ask the probe, which has the last word: if the internet answers, the provider is the problem.
 * Rejects with the signal's reason when interrupted.
 */
export async function isOutage(params: {
  send: SendRequestParams;
  failure: ModelApiError;
}): Promise<boolean> {
  const { send, failure } = params;
  const { policy, url, fetch, signal } = send;

  if (failure.reason === 'http') return false;

  if (policy.offlineTimeoutMs === 0 || policy.probeUrls.length === 0) return false;

  if (isLocalHost(url.hostname)) return false;

  return !(await internetReachable({ urls: policy.probeUrls, fetch, signal }));
}

/**
 * The outage is over, or is a new one: the connection answered (the next failure is the
 * provider's), or the machine slept. The budget is for time awake without a connection, so it
 * starts again from nothing.
 */
export function forgetOutage(standing: Standing): void {
  standing.offlineAwakeMs = 0;
  standing.offlineRounds = 0;
}

/** Adds what `elapsedMs` of a step expected to take `expectedMs` cost; a sleep starts the count again. */
function keepOfflineTime(params: {
  standing: Standing;
  elapsedMs: number;
  expectedMs: number;
}): void {
  const { standing, elapsedMs, expectedMs } = params;
  const { awakeMs, slept } = awakeTime({ elapsedMs, expectedMs });

  if (slept) {
    forgetOutage(standing);

    return;
  }

  standing.offlineAwakeMs += awakeMs;
}

/** The failure of a call whose lost connection did not come back within its budget. */
function outageError(params: { failure: ModelApiError; waitedMs: number }): ModelApiError {
  const { failure, waitedMs } = params;

  return new ModelApiError({
    reason: failure.reason,
    message: `${failure.message} (no connection for ${describeWait(waitedMs)})`,
    cause: failure,
  });
}

/**
 * One round of waiting for the connection after an attempt that started at `startedAt` failed
 * because there is none: says so once (`offline`), then waits, longer each round up to a cap, and
 * starts over right after a sleep. Throws once `policy.offlineTimeoutMs` of time awake went by
 * without it, or when `signal` aborts.
 */
export async function* waitForConnection(params: {
  send: SendRequestParams;
  failure: ModelApiError;
  standing: Standing;
  startedAt: number;
}): AsyncGenerator<ConnectionReport, void> {
  const { send, failure, standing, startedAt } = params;
  const { policy, signal } = send;

  keepOfflineTime({
    standing,
    elapsedMs: now() - startedAt,
    expectedMs: policy.responseTimeoutMs + PROBE_TIMEOUT_MS,
  });

  if (standing.offlineAwakeMs >= policy.offlineTimeoutMs) {
    throw outageError({ failure, waitedMs: standing.offlineAwakeMs });
  }

  if (standing.last !== 'offline') {
    standing.last = 'offline';
    yield {
      type: 'model_connection',
      connection: { state: 'offline', error: providerErrorText(failure.message) },
    };
  }

  const delayMs = offlineBackoffMs({
    round: standing.offlineRounds,
    retryDelayMs: policy.retryDelayMs,
    random: Math.random,
  });
  const waited = await waitAwake({ ms: delayMs, signal });

  if (waited.slept) {
    forgetOutage(standing);

    return;
  }

  standing.offlineRounds += 1;
  standing.offlineAwakeMs += waited.awakeMs;
}

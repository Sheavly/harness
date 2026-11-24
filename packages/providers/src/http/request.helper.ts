import { providerErrorText } from '@sheavly/core/text/diagnostic-text.utils';
import { ModelApiError, ModelFetchError } from '../errors/providers.errors.js';
import { now } from '@sheavly/core/clock/clock.helper';
import type { ConnectionReport, SendParams, Standing } from './http.types.js';
import { isOutage, waitForConnection } from './outage.helper.js';
import { withSignature } from './signing.utils.js';
import {
  backoffMs,
  isRetryableStatus,
  isWorthWaiting,
  retryAfterMs,
} from './retry-policy.helper.js';
import { wait } from './wait.helper.js';

/** What the failed request's error says, with Node's real reason (on `cause`) named. */
function networkMessage(caughtError: unknown): string {
  const cause = caughtError instanceof Error ? caughtError.cause : undefined;
  const code = (cause as { code?: unknown } | undefined)?.code;
  const detail = cause instanceof Error ? cause.message : undefined;
  const reason = [typeof code === 'string' ? code : undefined, detail].filter(Boolean).join(': ');
  const message = caughtError instanceof Error ? caughtError.message : String(caughtError);

  return providerErrorText(reason ? `${message} (${reason})` : message);
}

/** One attempt's outcome: the response, or a failure and whether another attempt may help. */
type Attempt =
  { response: Response } | { failure: ModelApiError; retryable: boolean; waitMs: number };

async function attempt(params: SendParams): Promise<Attempt> {
  const { api, fetch, url, policy, signal, sign } = params;
  // Signed afresh for each attempt: a signature carries the time, and one is good for minutes.
  const init = sign ? withSignature({ init: params.init, url, sign }) : params.init;
  const timeout = new AbortController();
  const timer = setTimeout(() => {
    timeout.abort();
  }, policy.responseTimeoutMs);

  try {
    // The timeout covers the wait for the response headers only: it is cleared once they arrive,
    // so a long reply streams for as long as it takes.
    const response = await fetch(url, {
      ...init,
      signal: AbortSignal.any([signal, timeout.signal]),
    });

    if (response.ok && response.body) return { response };

    const waitMs = retryAfterMs(response.headers);

    return {
      failure: new ModelApiError({
        reason: 'http',
        status: response.status,
        message: `${api} error ${response.status}: ${providerErrorText(await response.text())}`,
      }),
      retryable: isRetryableStatus(response.status) && isWorthWaiting(waitMs),
      waitMs,
    };
  } catch (caughtError) {
    // The caller's interrupt is no failure to retry or rename: it goes up as it came. Nor is a
    // request the model fetch can't send: a bug in the protocol that no retry changes.
    if (signal.aborted || caughtError instanceof ModelFetchError) throw caughtError;

    const timedOut = timeout.signal.aborted;

    return {
      failure: new ModelApiError({
        reason: timedOut ? 'timeout' : 'network',
        message: timedOut
          ? `The ${api} did not start a response within ${String(policy.responseTimeoutMs)}ms`
          : `The ${api} request failed: ${networkMessage(caughtError)}`,
        cause: caughtError,
      }),
      retryable: true,
      waitMs: 0,
    };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Sends one model API call under `policy` and returns the response once it started: on a network
 * error, a response that doesn't start in time, HTTP 429 or 5xx, it is sent again, up to
 * `policy.retries` more times, waiting `retryDelayMs` (doubled each time, or the server's
 * `retry-after` if longer). Nothing has streamed yet, so a retry repeats nothing. Any other HTTP
 * error fails at once; an interrupt (`signal`) stops the wait and every attempt. `api` names the
 * API in its errors (`Responses API`, `Anthropic Messages API`). With `sign`, every attempt, a
 * retry included, is signed anew from the headers and string body in `init`.
 *
 * A call that gets no HTTP answer waits instead when this machine has no connection (every
 * `policy.probeUrls` fails too; see `isOutage`), for up to `policy.offlineTimeoutMs` of time
 * awake, and reports it as it goes: it yields `offline` once, `provider_unreachable` before each
 * retry of the provider's own failures, and `restored` when a call that reported got through.
 * The generator returns the response, so a caller reads it with `yield*`.
 */
export async function* sendRequest(params: SendParams): AsyncGenerator<ConnectionReport, Response> {
  const { policy, signal } = params;
  const standing: Standing = { last: undefined, offlineAwakeMs: 0, offlineRounds: 0 };

  // `tried` counts the retries the provider's own failures used; waiting for a connection has its own budget.
  for (let tried = 0; ;) {
    const startedAt = now();
    const outcome = await attempt(params);

    if ('response' in outcome) {
      if (standing.last) yield { type: 'model_connection', state: 'restored' };

      return outcome.response;
    }

    if (await isOutage({ send: params, failure: outcome.failure })) {
      yield* waitForConnection({ send: params, failure: outcome.failure, standing, startedAt });

      continue;
    }

    if (!outcome.retryable || tried >= policy.retries) {
      throw failureAfter({ failure: outcome.failure, attempts: tried + 1 });
    }

    standing.last = 'provider_unreachable';
    yield {
      type: 'model_connection',
      state: 'provider_unreachable',
      error: outcome.failure.message,
      attempt: tried + 1,
      retries: policy.retries,
    };

    await wait({
      ms: backoffMs({
        tried,
        retryDelayMs: policy.retryDelayMs,
        serverWaitMs: outcome.waitMs,
        random: Math.random,
      }),
      signal,
    });
    tried += 1;
  }
}

/** The error a call ends with: the failure itself after one attempt, else it says how many were made. */
function failureAfter(params: { failure: ModelApiError; attempts: number }): ModelApiError {
  const { failure, attempts } = params;

  if (attempts === 1) return failure;

  return new ModelApiError({
    reason: failure.reason,
    message: `${failure.message} (after ${String(attempts)} attempts)`,
    ...(failure.status === undefined ? {} : { status: failure.status }),
    cause: failure,
  });
}

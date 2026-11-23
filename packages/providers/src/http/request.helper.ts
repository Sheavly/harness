import { providerErrorText } from '@sheavly/core/text/diagnostic-text.utils';
import { ModelApiError, ModelFetchError } from '../errors/providers.errors.js';
import type { RequestPolicy, RequestSigner } from './http.types.js';
import { withSignature } from './signing.utils.js';
import {
  backoffMs,
  isRetryableStatus,
  isWorthWaiting,
  retryAfterMs,
} from './retry-policy.helper.js';

/** Waits `ms`, or rejects as soon as `signal` aborts. */
function wait(params: { ms: number; signal: AbortSignal }): Promise<void> {
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

async function attempt(params: {
  api: string;
  fetch: typeof fetch;
  url: URL;
  init: RequestInit;
  policy: RequestPolicy;
  signal: AbortSignal;
  sign?: RequestSigner | undefined;
}): Promise<Attempt> {
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
 */
export async function sendRequest(params: {
  api: string;
  fetch: typeof fetch;
  url: URL;
  init: RequestInit;
  policy: RequestPolicy;
  signal: AbortSignal;
  sign?: RequestSigner | undefined;
}): Promise<Response> {
  const { policy, signal } = params;

  for (let tried = 0; ; tried++) {
    const outcome = await attempt(params);

    if ('response' in outcome) return outcome.response;

    if (!outcome.retryable || tried >= policy.retries) {
      if (tried === 0) throw outcome.failure;

      throw new ModelApiError({
        reason: outcome.failure.reason,
        message: `${outcome.failure.message} (after ${String(tried + 1)} attempts)`,
        ...(outcome.failure.status === undefined ? {} : { status: outcome.failure.status }),
        cause: outcome.failure,
      });
    }

    await wait({
      ms: backoffMs({
        tried,
        retryDelayMs: policy.retryDelayMs,
        serverWaitMs: outcome.waitMs,
        random: Math.random,
      }),
      signal,
    });
  }
}

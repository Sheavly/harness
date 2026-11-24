import { PROBE_TIMEOUT_MS } from './http.constants.js';

/** Asks one address for its headers and drops the answer: any HTTP answer shows the path is up. */
async function reached(params: {
  url: string;
  fetch: typeof globalThis.fetch;
  signal: AbortSignal;
}): Promise<void> {
  const { url, fetch, signal } = params;
  // A bare HEAD that follows no redirect: a 3xx is an answer too, and it must not send the probe on.
  const response = await fetch(url, {
    method: 'HEAD',
    redirect: 'manual',
    signal: AbortSignal.any([signal, AbortSignal.timeout(PROBE_TIMEOUT_MS)]),
  });

  // The answer is what counts: a body that will not cancel does not make the path down.
  await response.body?.cancel().catch(ignoreCancelFailure);
}

/** A failed cancel is an error about a body already answered; anything else is not that. */
function ignoreCancelFailure(caughtError: unknown): void {
  if (!(caughtError instanceof Error)) throw caughtError;
}

/**
 * Whether the internet is reachable from here, whatever the model's provider is doing: true as soon
 * as any of `urls` answers over the same `fetch` a model call uses (so a proxy or a firewall
 * judges the probe as it judges the call), whatever the status, false once every one failed or
 * timed out. Rejects with the signal's reason when `signal` aborts.
 */
export async function internetReachable(params: {
  urls: readonly string[];
  fetch: typeof globalThis.fetch;
  signal: AbortSignal;
}): Promise<boolean> {
  const { urls, fetch, signal } = params;
  const answered = new AbortController();
  const probing = AbortSignal.any([signal, answered.signal]);

  try {
    await Promise.any(urls.map((url) => reached({ url, fetch, signal: probing })));

    return true;
  } catch (caughtError) {
    // Only "every probe failed" means offline; an interrupt goes up as it came.
    if (signal.aborted) throw signal.reason;

    if (caughtError instanceof AggregateError) return false;

    throw caughtError;
  } finally {
    // One answer is enough: the probes still waiting are stopped, not left to time out.
    answered.abort();
  }
}

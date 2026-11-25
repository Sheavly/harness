import type { RequestPolicy } from '../http/http.types.js';
import type { FailedCheck } from './registry.types.js';

/** Stands in for a secret while a definition is checked, so the key itself is never needed. */
export const SECRET_STAND_IN = 'x';

/** How long a check waits for the model to start answering. */
export const CHECK_RESPONSE_TIMEOUT_MS = 30_000;

/** The first HTTP status that is the server's failure, not a refusal of the request. */
export const CHECK_SERVER_ERROR_FROM = 500;

/**
 * How a check sends its one call. Not the host's chat policy: a check that is wrong should say so
 * at once, so there are no retries and no waiting for a connection (an unreachable provider is
 * the answer), and the response timeout is the check's own, in `check`.
 */
export const CHECK_REQUEST: RequestPolicy = {
  responseTimeoutMs: CHECK_RESPONSE_TIMEOUT_MS,
  retries: 0,
  retryDelayMs: 0,
  offlineTimeoutMs: 0,
  probeUrls: [],
};

/**
 * What a failed check says, per status. Fixed text: never what the provider answered, since that
 * can echo what was sent, and a key must not come back in a result.
 */
export const CHECK_MESSAGES: Record<FailedCheck, string> = {
  invalid: 'The provider refused the key',
  not_found: 'The endpoint or the deployment was not found',
  rejected: 'The provider answered but refused the request',
  unreachable: 'The provider could not be reached in time',
};

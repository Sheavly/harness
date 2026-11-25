import type { RequestPolicy } from '../http/http.types.js';

/**
 * Test-only: the request policy tests send calls with. No retries, no wait and no waiting for a
 * connection, so a failure shows at once; a timeout long enough that no fake response ever hits it.
 */
export const TEST_REQUEST: RequestPolicy = {
  responseTimeoutMs: 5000,
  retries: 0,
  retryDelayMs: 0,
  offlineTimeoutMs: 0,
  probeUrls: [],
};

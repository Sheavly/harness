/** Test-only: runs `sendRequest` to its end. */
import type { ConnectionReport, SendRequestParams } from '../http/http.types.js';
import { sendRequest } from '../http/request.helper.js';

/**
 * Sends `params` and returns the response with what the call reported on the way, in order. A
 * generator's return value is only reachable by driving it by hand, which `for await` can't do.
 */
export async function sendCollecting(
  params: SendRequestParams,
): Promise<{ response: Response; reports: ConnectionReport[] }> {
  const reports: ConnectionReport[] = [];
  const call = sendRequest(params);

  for (;;) {
    const step = await call.next();

    if (step.done) return { response: step.value, reports };

    reports.push(step.value);
  }
}

/**
 * What a detached `cancel()` of a body that is being thrown away rejects with says nothing the run
 * needs (the answer, or the loss, is already known), and rethrown from a promise nobody holds it
 * would be an unhandled rejection that ends the process. So whatever it was, it stops here.
 */
export function ignoreCancelFailure(_reason: unknown): void {
  return undefined;
}

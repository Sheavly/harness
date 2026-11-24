/** How the connection to a provider was lost in the middle of a reply. */
type ConnectionLoss =
  /** The connection broke while the reply was being read (a reset, a timeout, a cut network). */
  | 'dropped'
  /** Nothing arrived for too long: a connection that died without saying so (a sleep, a dead route). */
  | 'idle';

/**
 * A provider's connection was lost after its reply had started, so what it sent is partial but
 * valid: the text and the whole tool calls it had streamed. The loop recovers from it, once per
 * model call and a few times in a row, by keeping that partial reply and asking the model to go
 * on, instead of failing the run. A provider throws it only for a lost connection, never for a
 * reply that is wrong (an error event, a payload that is not JSON), which no retry changes.
 */
export class ConnectionLostError extends Error {
  override name = 'ConnectionLostError';
  readonly reason: ConnectionLoss;

  constructor(params: { reason: ConnectionLoss; message: string; cause?: unknown }) {
    const { reason, message, cause } = params;

    super(message, cause === undefined ? undefined : { cause });
    this.reason = reason;
  }
}

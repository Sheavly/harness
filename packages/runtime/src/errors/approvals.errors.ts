import { errorMessage } from './errors.utils.js';
import type { ApprovalUpdate } from '@sheavly/protocol/approval/approval.types';

/**
 * A subscriber threw while hearing an update. Every other listener still hears it; then this
 * reaches whoever caused the update (the waiting request, or the UI that called `respond`).
 */
export class ApprovalListenerError extends Error {
  override name = 'ApprovalListenerError';
  /** The update the listener failed on. */
  readonly update: ApprovalUpdate['type'];

  constructor(params: { update: ApprovalUpdate['type']; cause: unknown }) {
    const { update, cause } = params;

    super(`An approval listener failed on ${update}: ${errorMessage(cause)}`, { cause });
    this.update = update;
  }
}

/** Why an approval couldn't be asked for or answered. */
type ApprovalRequestReason =
  'no_listener' | 'unknown_id' | 'not_offered' | 'session_ended' | 'too_many_pending';

/**
 * An approval can't go ahead: nobody is listening to ask (`no_listener`, so the call fails
 * closed), an answer names a request that isn't waiting (`unknown_id`), it gives a decision
 * the request didn't offer (`not_offered`; the request keeps waiting), the session that asked
 * ended while it waited (`session_ended`), or too many are already waiting (`too_many_pending`,
 * which fails closed as well).
 */
export class ApprovalRequestError extends Error {
  override name = 'ApprovalRequestError';
  readonly reason: ApprovalRequestReason;

  constructor(params: { reason: ApprovalRequestReason; message: string }) {
    const { reason, message } = params;

    super(message);
    this.reason = reason;
  }
}

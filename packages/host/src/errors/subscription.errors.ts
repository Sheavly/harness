/**
 * Why a subscription was refused, for a transport to map to its own errors (the server's codes):
 * the request cannot be served as asked (a position of the wrong kind for its channel, a tail or a
 * read over its bound), a position the channel's log cannot start at, or the conversation already
 * serves as many subscriptions as it may. A conversation or a channel that is not there is a
 * `ConversationsError` (`not_found`), the same for both.
 */
type SubscriptionFailure = 'bad_request' | 'cursor_out_of_range' | 'too_many_subscriptions';

export class SubscriptionError extends Error {
  override name = 'SubscriptionError';
  readonly reason: SubscriptionFailure;

  constructor(params: { reason: SubscriptionFailure; message: string; cause?: unknown }) {
    const { reason, message, cause } = params;

    super(message, { cause });
    this.reason = reason;
  }
}

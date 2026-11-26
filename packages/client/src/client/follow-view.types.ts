import type { ConversationChannelName } from '@sheavly/protocol/channel/channel.types';
import type { ConversationId } from '@sheavly/protocol/server/server.types';
import type { SubscribeFrame } from '@sheavly/protocol/subscription/subscription.types';
import type { createClient } from './client.helper.js';

/**
 * A channel of a conversation as it is followed: `view()` is what it is now, and `ended` settles
 * when the following does (the signal aborted, or the channel ended) or rejects with why it could
 * not go on. Attach a handler to `ended`: a failure with none is an unhandled rejection.
 */
export type FollowedView<View> = {
  view: () => View;
  ended: Promise<void>;
};

/** What following a conversation's own channel as a view takes. */
export type FollowViewParams<View> = {
  client: ReturnType<typeof createClient>;
  id: ConversationId;
  /** The conversation's own channel to follow: one that has a snapshot. */
  channel: ConversationChannelName;
  /** The view before the first frame. */
  empty: View;
  /**
   * The view after `frame`: the channel's snapshot replaces it, an entry of the channel is folded in,
   * and any other frame changes nothing. It returns the view it was given, the same object, when
   * nothing changed, which is how a change is told from none; it throws what a server off the
   * contract earns (an `AnswerError`).
   */
  fold: (params: { view: View; frame: SubscribeFrame }) => View;
  /** Told each time the view changes. */
  onChange: (view: View) => void;
  signal: AbortSignal;
  /** This client answers approvals while it follows: only the tree channel has any. */
  approvals?: boolean;
};

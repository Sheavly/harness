import type { UsageView } from '@sheavly/protocol/usage/usage.types';

/**
 * A conversation's usage as it is followed: `usage()` is what it is now, the total and each node's,
 * and `ended` settles when the following does (the signal aborted, or the channel ended) or rejects
 * with why it could not go on. Attach a handler to `ended`: a failure with none is an unhandled
 * rejection.
 */
export type WatchedUsage = {
  usage: () => UsageView;
  ended: Promise<void>;
};

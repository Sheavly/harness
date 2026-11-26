import type { TreeView } from '@sheavly/protocol/tree/tree.types';

/**
 * A conversation's tree as it is followed: `tree()` is what it is now, and `ended` settles when
 * the following does (the signal aborted, or the tree channel ended) or rejects with why it could
 * not go on. Attach a handler to `ended`: a failure with none is an unhandled rejection.
 */
export type WatchedTree = {
  tree: () => TreeView;
  ended: Promise<void>;
};

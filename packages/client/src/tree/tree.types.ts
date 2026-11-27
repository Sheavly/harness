import type { TreeChannelEntry, TreeView } from '@sheavly/protocol/tree/tree.types';

/**
 * Told of one entry of the tree channel with the tree before it and after it: the same object when
 * the entry changes nothing in the tree (a queue change, a prompt, a notice).
 */
export type TreeEntryListener = (params: {
  entry: TreeChannelEntry;
  before: TreeView;
  after: TreeView;
}) => void;

/**
 * A conversation's tree as it is followed: `tree()` is what it is now, and `ended` settles when
 * the following does (the signal aborted, or the tree channel ended) or rejects with why it could
 * not go on. Attach a handler to `ended`: a failure with none is an unhandled rejection.
 */
export type WatchedTree = {
  tree: () => TreeView;
  ended: Promise<void>;
};

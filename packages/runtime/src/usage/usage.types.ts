import type { NodeId } from '@sheavly/protocol/node/node.types';
import type { NodeUsage, UsageFigures } from '@sheavly/protocol/usage/usage.types';

/** What changed when the ledger counted something: the node's record, the total, and what it dropped. */
export type NodeUsageChange = {
  /** The node's figures as they now are. */
  usage: NodeUsage;
  /** The conversation's total as it now is. */
  total: UsageFigures;
  /** The nodes whose records were dropped to keep to `MAX_TREE_NODES`; their calls stay in the total. */
  evicted: NodeId[];
};

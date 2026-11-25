import type { z } from 'zod';
import type { treeChannelEntrySchema, treeSnapshotSchema } from './tree.validator.js';

/** One entry of a conversation's tree channel: a node, an approval, or a notice of the conversation. */
export type TreeChannelEntry = z.infer<typeof treeChannelEntrySchema>;

/** The tree as it stands, with the cursor of the entry it covers up to. */
export type TreeSnapshot = z.infer<typeof treeSnapshotSchema>;

/**
 * What the entries of the tree channel build up: every node, ended ones included, and every
 * approval still waiting. It is a snapshot without the cursor it is taken at.
 */
export type TreeView = Pick<TreeSnapshot, 'nodes' | 'approvals'>;

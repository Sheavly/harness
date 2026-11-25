import { StoreError } from '@sheavly/core/errors/store.errors';
import type { TreeSnapshot } from '@sheavly/protocol/tree/tree.types';
import type { TreeChannelWriter } from '@sheavly/runtime/nodes/tree-channel-writer.service';
import { ConversationsError } from '../errors/conversations.errors.js';

/**
 * The tree of a conversation as its tree channel's writer has stored it, with the cursor to follow
 * from (`TreeChannelWriter.snapshot`, which waits for what was told to be stored first). A client
 * that starts from it and follows after that cursor ends with what one that replayed the channel
 * does. `not_found` when the conversation keeps no tree (its host stores nothing), and
 * `storage_failed` when the channel could not be stored and holds nothing to say.
 */
export async function treeSnapshotOf(tree: TreeChannelWriter | undefined): Promise<TreeSnapshot> {
  if (!tree) {
    throw new ConversationsError({
      reason: 'not_found',
      message: 'This conversation keeps no tree: its host stores nothing',
    });
  }

  try {
    return await tree.snapshot();
  } catch (caughtError) {
    if (!(caughtError instanceof StoreError)) throw caughtError;

    throw new ConversationsError({
      reason: 'storage_failed',
      message: `The tree of this conversation could not be stored (${caughtError.message}), so it has no snapshot`,
      cause: caughtError,
    });
  }
}

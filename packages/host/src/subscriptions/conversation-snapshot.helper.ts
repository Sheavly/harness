import { StoreError } from '@sheavly/core/errors/store.errors';
import { ConversationsError } from '../errors/conversations.errors.js';

/**
 * The view of one of a conversation's own channels (`name`, the tree for instance) as its writer
 * has stored it, with the cursor to follow from (`snapshot`, which waits for what was told to be
 * stored first). A client that starts from it and follows after that cursor ends with what one that
 * replayed the channel does. `not_found` when the conversation keeps no such channel (its host
 * stores nothing), and `storage_failed` when the channel could not be stored and holds nothing to
 * say.
 */
export async function snapshotOfChannel<Snapshot>(params: {
  channel: { snapshot: () => Promise<Snapshot> } | undefined;
  name: string;
}): Promise<Snapshot> {
  const { channel, name } = params;

  if (!channel) {
    throw new ConversationsError({
      reason: 'not_found',
      message: `This conversation keeps no ${name}: its host stores nothing`,
    });
  }

  try {
    return await channel.snapshot();
  } catch (caughtError) {
    if (!(caughtError instanceof StoreError)) throw caughtError;

    throw new ConversationsError({
      reason: 'storage_failed',
      message: `The ${name} of this conversation could not be stored (${caughtError.message}), so it has no snapshot`,
      cause: caughtError,
    });
  }
}

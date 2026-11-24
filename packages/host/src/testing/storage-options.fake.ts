import type { ConversationStorage } from '../conversations/conversations.types.js';

/**
 * Test-only: the `createHarness` options a conversation's `storage` becomes, as an app wires them:
 * the stream to `entries`, the stored log to `resume`, and the nodes' channels to `channels`.
 * None for a conversation that is not kept.
 */
export function harnessStorageOptions(storage: ConversationStorage | undefined) {
  if (!storage) return {};

  return { entries: storage.entries, resume: storage.resume, channels: storage.channels };
}

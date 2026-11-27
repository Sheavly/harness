import { StoreError } from '@sheavly/core/errors/store.errors';
import type { ChannelPosition } from './nodes.types.js';

/**
 * The `spawnedAt` a child's `opened` entry carries: where its parent's channel stood, which is the
 * newest entry the store took of it (`state.stored`). None for a node with no parent. Throws
 * `invalid` when the parent's channel holds nothing yet, which a child cannot be linked to.
 */
export function spawnedAtOf(
  parent: { channel?: string; state?: { stored?: string } } | undefined,
): { spawnedAt?: ChannelPosition } {
  if (!parent?.channel) return {};

  const cursor = parent.state?.stored;

  if (cursor === undefined) {
    throw new StoreError({
      reason: 'invalid',
      message: `The channel of node ${parent.channel} holds nothing to link a child to`,
    });
  }

  return { spawnedAt: { channel: parent.channel, cursor } };
}

import type { StoreError } from '@sheavly/core/errors/store.errors';
import type { ConversationChannelName } from '@sheavly/protocol/channel/channel.types';
import { isConversationChannel } from '@sheavly/protocol/channel/channel.utils';
import { NodeError } from '../errors/nodes.errors.js';
import type { ConversationChannel } from './nodes.types.js';

/**
 * The channels of the conversation itself a harness stores, by name (the tree is the first). The
 * host serves, waits for and stops them through this and knows none by its own name, so a channel
 * added to the family is served by adding it here and nowhere else.
 */
export class ConversationChannels {
  readonly #channels = new Map<ConversationChannelName, ConversationChannel>();

  /** Adds `channel`. Throws for a name already held: a channel has one writer. */
  add(channel: ConversationChannel): void {
    if (this.#channels.has(channel.name)) {
      throw new NodeError({
        reason: 'duplicate_channel',
        message: `The conversation already has a ${channel.name} channel`,
      });
    }

    this.#channels.set(channel.name, channel);
  }

  /** The channel named `name`, or none: a node's id, or a conversation channel this host does not keep. */
  get(name: string): ConversationChannel | undefined {
    return isConversationChannel(name) ? this.#channels.get(name) : undefined;
  }

  /** The first failed write of each channel that has failed, in the order the channels were added. */
  get failures(): StoreError[] {
    return [...this.#channels.values()].flatMap(({ failure }) => (failure ? [failure] : []));
  }

  /**
   * Resolves once everything told to the channels named in `names` (every channel when none are
   * named) has been written, or its write has failed. A name that is not held is skipped.
   */
  async flush(names?: readonly string[]): Promise<void> {
    const wanted = names
      ? names.flatMap((name) => this.get(name) ?? [])
      : [...this.#channels.values()];

    await Promise.all(wanted.map((channel) => channel.flush()));
  }

  /** Stops every channel, for a conversation that was closed: what was told is written first. */
  async stop(): Promise<void> {
    await Promise.all([...this.#channels.values()].map((channel) => channel.stop()));
  }
}

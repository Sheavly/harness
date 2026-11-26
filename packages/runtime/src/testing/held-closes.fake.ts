import type { ChannelEntry, ChannelFrom, ChannelLog } from '@sheavly/core/store/store.types';
import { MemoryConversationStore } from '@sheavly/testing/store/memory-store.fake';

/**
 * Test-only: a memory store whose channels hold the append of a `closed` entry until `release`,
 * as a slow disk does, so a test can look at a node that has ended and whose last entry is not
 * stored yet. `reached` resolves once such an append is waiting.
 */
export class HeldCloses extends MemoryConversationStore {
  readonly reached = Promise.withResolvers<undefined>();
  readonly #go = Promise.withResolvers<undefined>();

  release(): void {
    this.#go.resolve(undefined);
  }

  override channel(params: Parameters<MemoryConversationStore['channel']>[0]): ChannelLog {
    const log = super.channel(params);

    return {
      append: async (entry: ChannelEntry) => {
        if (entry.type === 'closed') {
          this.reached.resolve(undefined);
          await this.#go.promise;
        }

        await log.append(entry);
      },
      head: () => log.head(),
      read: (from?: ChannelFrom) => log.read(from),
    };
  }
}

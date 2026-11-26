import type { StoreError } from '@sheavly/core/errors/store.errors';
import type { ChannelLog, ConversationStore } from '@sheavly/core/store/store.types';
import { USAGE_CHANNEL_NAME } from '@sheavly/protocol/node/node.constants';
import type { NodeId } from '@sheavly/protocol/node/node.types';
import type { ConversationId } from '@sheavly/protocol/server/server.types';
import type { StreamEntry } from '@sheavly/protocol/stream/stream.types';
import type {
  UsageChannelEntry,
  UsageSnapshot,
  UsageView,
} from '@sheavly/protocol/usage/usage.types';
import { emptyUsageFigures } from '@sheavly/protocol/usage/usage.utils';
import { NodeUsageLedger } from '../usage/node-usage.service.js';
import type { NodeRegistry } from './node-registry.service.js';
import type { ConversationChannel, EventSource, NodeChannelStorage } from './nodes.types.js';
import { isOpenState } from './nodes.utils.js';
import { readStoredChannel } from './stored-channel.helper.js';
import { StoredChannel } from './stored-channel.service.js';
import type { ResumedChannel } from './stored-channel.types.js';
import { nodeUsageEntry, usageOpenedEntry } from './usage-channel-entries.utils.js';
import { usageChannelRules } from './usage-channel-rules.utils.js';

/**
 * Stores a conversation's usage channel: what each node's model calls have used, and the total. It
 * counts the loop's `usage` events as the sessions publish them (`NodeUsageLedger`, the one place
 * usage is counted) and tells the channel a `node_usage` entry for each change, holding the node's
 * figures and the total as they now are, so a client only replaces what it holds. The storing, with
 * its ordering, its snapshot and its failure, is the stored channel's (`StoredChannel`), which this
 * is one of.
 *
 * A reopened conversation goes on from what its stored channel left, with the nodes it already
 * recorded: the total covers the earlier ones, and each record stays under the id of the node it
 * was made for. One reopened with no usage channel stored (kept before it existed) opens a new one
 * that says it did not count what came before (`earlierUncounted`), so its figures read as a lower
 * bound. What a call made while a write was failing, or before a crash, would have added is not in
 * the channel either: it stores what was written, and a reopen goes on from that.
 */
export class UsageChannelWriter
  extends StoredChannel<UsageChannelEntry, UsageView, UsageSnapshot>
  implements ConversationChannel
{
  readonly #ledger: NodeUsageLedger;

  constructor(params: {
    log: ChannelLog;
    /** Whether a node is open: the record of one that is not may be dropped when too many are kept. */
    isOpen: (node: NodeId) => boolean;
    onFailure?: ((failure: StoreError) => void) | undefined;
    resumed?: ResumedChannel<UsageView> | undefined;
    /** The channel is opened by a conversation that had already made calls it did not count. */
    earlierUncounted?: boolean;
  }) {
    const { resumed } = params;

    super({ ...usageChannelRules, log: params.log, onFailure: params.onFailure, resumed });
    this.#ledger = new NodeUsageLedger({
      isOpen: params.isOpen,
      ...(resumed && 'view' in resumed && { initial: resumed.view }),
      // The opening entry says the same, so the ledger's total and the stored channel's agree.
      ...(params.earlierUncounted && {
        initial: { total: { ...emptyUsageFigures(), incomplete: true }, nodes: [] },
      }),
    });
  }

  /**
   * The stored usage channel of a conversation being reopened, for `NodeChannelStorage.resumedUsage`:
   * where it stands and the usage its entries build. Undefined when none is stored (a conversation
   * kept before it was), and a failure when it cannot be gone on from (`readStoredChannel`).
   */
  static readStored(params: {
    store: Pick<ConversationStore, 'channel' | 'channels'>;
    id: ConversationId;
  }): Promise<ResumedChannel<UsageView> | undefined> {
    return readStoredChannel({ ...params, ...usageChannelRules });
  }

  /**
   * Starts storing a conversation's usage channel, from what the loops of its sessions report from
   * now on. Call it once, right after the registries are made: the channel opens (a reopened one
   * goes on), and each `usage` and `turn_end` event of a session that is a node is counted. A node
   * is open while it runs or waits, and the record of one that is not is the first to go when more
   * are kept than a snapshot holds.
   */
  static attach(params: {
    nodes: NodeRegistry;
    events: EventSource;
    storage: NodeChannelStorage;
  }): UsageChannelWriter {
    const { nodes, events, storage } = params;
    const writer = new UsageChannelWriter({
      log: storage.log(USAGE_CHANNEL_NAME),
      isOpen: (node) => {
        const state = nodes.get(node)?.state;

        return state !== undefined && isOpenState(state);
      },
      onFailure: storage.onFailure,
      resumed: storage.resumedUsage,
      earlierUncounted: !storage.resumedUsage && storage.reopened === true,
    });

    if (!storage.resumedUsage) {
      const earlierUncounted = storage.reopened === true;

      writer.tell((stamp) => usageOpenedEntry({ ...stamp, earlierUncounted }));
    }

    events.subscribeEntries((entry) => {
      writer.#count({ entry, node: events.nodeIdOf(entry.sessionId) });
    });

    return writer;
  }

  /** Counts the usage an entry of the combined stream reports, for the node its session is. */
  #count(params: { entry: StreamEntry; node: NodeId | undefined }): void {
    const { entry, node } = params;

    if (entry.kind !== 'event' || node === undefined) return;

    const change = this.#ledger.observe({ node, event: entry.event });

    if (change) this.tell((stamp) => nodeUsageEntry({ ...stamp, ...change }));
  }
}

import type { ConversationStore } from '@sheavly/core/store/store.types';
import { TREE_CHANNEL_NAME } from '@sheavly/protocol/node/node.constants';
import type { ConversationId } from '@sheavly/protocol/server/server.types';
import type { SubscribeRequest } from '@sheavly/protocol/subscription/subscription.types';
import { subscribeRequestSchema } from '@sheavly/protocol/subscription/subscription.validator';
import { ConversationsError } from '../errors/conversations.errors.js';
import { SubscriptionError } from '../errors/subscription.errors.js';
import type { LiveConversation } from '../conversations/conversations.types.js';
import { HeldBytes } from './held-bytes.service.js';
import { checkPosition, kindOf } from './subscription-read.helper.js';
import { Subscription } from './subscription.service.js';
import {
  MAX_HELD_BYTES,
  MAX_SUBSCRIBE_READ_BYTES,
  MAX_SUBSCRIPTION_CONNECTIONS,
  NO_SUCH_CHANNEL,
} from './subscriptions.constants.js';
import type { ResolvedChannel } from './subscriptions.types.js';

const noSuchChannel = () =>
  new ConversationsError({ reason: 'not_found', message: NO_SUCH_CHANNEL });

/**
 * The subscriptions a host serves, by conversation: it decides whether a request may be served
 * (the connections a conversation holds, the channels it has, the positions they can be asked
 * for), and opens the subscription. A conversation closing needs nothing of it: the writer ends
 * every channel it writes, and a subscription ends with its channels.
 *
 * A channel is the conversation's only if its store lists it: another conversation's node, an
 * unknown id and the tree channel (which is not stored) all answer `not_found` with one message,
 * so a request learns nothing about channels it cannot reach.
 */
export class SubscriptionHub {
  readonly #store: ConversationStore | undefined;
  /**
   * Per conversation with subscriptions open or being opened: how many, which is what the
   * connection bound counts, and the bytes they may hold together. Gone with the last of them.
   */
  readonly #held = new Map<ConversationId, { count: number; pool: HeldBytes }>();

  constructor(params: { store: ConversationStore | undefined }) {
    this.#store = params.store;
  }

  /**
   * Opens a subscription to the channels `request` names, in conversation `id` (`live`). Refuses,
   * before reading anything of the history, a request for a channel the conversation does not have
   * (`not_found`), a position it cannot be asked for (`bad_request`) or a conversation that serves
   * as many as it may (`too_many_subscriptions`); then reads, and refuses a position its log cannot
   * start at (`cursor_out_of_range`), a read over `MAX_SUBSCRIBE_READ_BYTES` (`bad_request`) or
   * history that does not fit in what the conversation's subscriptions may hold
   * (`too_many_subscriptions`). An aborted `signal` stops the read. The request is parsed again, so
   * a caller that built one by hand gets the contract's bounds too (a ZodError for one it refuses).
   * The caller closes what it gets.
   */
  async open(params: {
    id: ConversationId;
    live: LiveConversation;
    request: SubscribeRequest;
    signal?: AbortSignal | undefined;
  }): Promise<Subscription> {
    const { id, live, signal } = params;
    const request = subscribeRequestSchema.parse(params.request);
    const { pool, release } = this.#reserve(id);

    try {
      const channels = await this.#resolve({ id, request });

      signal?.throwIfAborted();

      return await Subscription.open({
        writer: live.harness.nodeChannels,
        channels,
        budget: { left: MAX_SUBSCRIBE_READ_BYTES },
        pool,
        signal,
        onClose: release,
      });
    } catch (caughtError) {
      release();
      throw caughtError;
    }
  }

  /**
   * Takes one of the conversation's connections, or refuses; gives the bytes its subscriptions may
   * hold together, and the way to give the connection back, which is safe to call more than once.
   */
  #reserve(id: ConversationId): { pool: HeldBytes; release: () => void } {
    const held = this.#held.get(id) ?? { count: 0, pool: new HeldBytes(MAX_HELD_BYTES) };

    if (held.count >= MAX_SUBSCRIPTION_CONNECTIONS) {
      throw new SubscriptionError({
        reason: 'too_many_subscriptions',
        message: `This conversation serves ${String(MAX_SUBSCRIPTION_CONNECTIONS)} subscriptions already: ask again when one has ended`,
      });
    }

    held.count += 1;
    this.#held.set(id, held);

    let released = false;

    return {
      pool: held.pool,
      release: () => {
        if (released) return;

        released = true;
        held.count -= 1;

        if (held.count <= 0 && this.#held.get(id) === held) this.#held.delete(id);
      },
    };
  }

  /** The channels of `request` as the conversation has them, each checked for its position. */
  async #resolve(params: {
    id: ConversationId;
    request: SubscribeRequest;
  }): Promise<ResolvedChannel[]> {
    const { id, request } = params;
    const store = this.#store;
    const stored = new Set(store ? await store.channels(id) : []);
    const channels: ResolvedChannel[] = [];

    // Every name is looked up before any log is opened, so which of them is missing is not told.
    for (const { channel } of request.subscriptions) {
      if (channel === TREE_CHANNEL_NAME || !stored.has(channel)) throw noSuchChannel();
    }

    for (const { channel, from } of request.subscriptions) {
      const log = store?.channel({ id, channel });
      const kind = log && (await kindOf(log));

      if (!log || !kind) throw noSuchChannel();

      checkPosition({ from, kind });
      channels.push({ channel, from, log, kind });
    }

    return channels;
  }
}

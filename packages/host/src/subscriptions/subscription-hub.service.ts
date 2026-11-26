import type { ConversationStore } from '@sheavly/core/store/store.types';
import { TREE_CHANNEL_NAME } from '@sheavly/protocol/node/node.constants';
import type { ConversationId } from '@sheavly/protocol/server/server.types';
import type { SubscribeRequest } from '@sheavly/protocol/subscription/subscription.types';
import { subscribeRequestSchema } from '@sheavly/protocol/subscription/subscription.validator';
import { ConversationsError } from '../errors/conversations.errors.js';
import { SubscriptionError } from '../errors/subscription.errors.js';
import type { LiveConversation } from '../conversations/conversations.types.js';
import { HeldBytes } from './held-bytes.service.js';
import { checkPosition, kindOf, outputRefOf } from './subscription-read.helper.js';
import { Subscription } from './subscription.service.js';
import {
  MAX_HELD_BYTES,
  MAX_SUBSCRIBE_READ_BYTES,
  MAX_SUBSCRIPTION_CONNECTIONS,
  NO_SUCH_CHANNEL,
} from './subscriptions.constants.js';
import type { OutputSource, ResolvedChannel } from './subscriptions.types.js';

const noSuchChannel = () =>
  new ConversationsError({ reason: 'not_found', message: NO_SUCH_CHANNEL });

/**
 * What a connection that claims to answer approvals (`approvals: true`) is to the conversation: one
 * that is listening, so a request for approval waits for an answer instead of being refused for want
 * of one, for as long as the connection is open. A claim, not a check: the same as the
 * conversation's own stream makes with its flag. Returns the way to stop listening, which is safe to
 * call more than once and does nothing for a request that makes no claim.
 */
function listenForApprovals(params: {
  live: LiveConversation;
  request: SubscribeRequest;
}): () => void {
  const { live, request } = params;

  if (request.approvals !== true) return () => undefined;

  return live.harness.approvals.subscribe(() => undefined);
}

/**
 * The subscriptions a host serves, by conversation: it decides whether a request may be served
 * (the connections a conversation holds, the channels it has, the positions they can be asked
 * for), and opens the subscription. A conversation closing needs nothing of it: the writer ends
 * every channel it writes, and a subscription ends with its channels.
 *
 * A channel is the conversation's only if its store lists it: another conversation's node, an
 * unknown id and the tree channel of a conversation that stores none all answer `not_found` with
 * one message, so a request learns nothing about channels it cannot reach.
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
   * a caller that built one by hand gets the contract's bounds too (a ZodError for one it refuses,
   * such as `approvals` with no tree channel). A request with `approvals: true` counts as someone
   * who can answer approvals until the subscription closes, or the request is refused. The caller
   * closes what it gets.
   */
  async open(params: {
    id: ConversationId;
    live: LiveConversation;
    request: SubscribeRequest;
    signal?: AbortSignal | undefined;
  }): Promise<Subscription> {
    const { id, live, signal } = params;
    const request = subscribeRequestSchema.parse(params.request);
    const { pool, release: releaseConnection } = this.#reserve(id);
    // Listening from the moment the request is accepted: an approval asked while its history is
    // read waits too. Given back with the connection, whichever way the subscription ends.
    const stopListening = listenForApprovals({ live, request });
    const release = () => {
      releaseConnection();
      stopListening();
    };

    try {
      // The tree channel is listed once its first entry is stored, which is queued when the
      // conversation starts: a client that asks at once must not be told it has none.
      if (request.subscriptions.some(({ channel }) => channel === TREE_CHANNEL_NAME)) {
        await live.harness.treeChannel?.flush();
      }

      const channels = await this.#resolve({ id, request });

      signal?.throwIfAborted();

      return await Subscription.open({
        writer: live.harness.nodeChannels,
        tree: live.harness.treeChannel,
        output: this.#outputOf({ id, live }),
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

  /** Where a command's complete output of conversation `id` is read and followed; none when the host stores nothing. */
  #outputOf(params: { id: ConversationId; live: LiveConversation }): OutputSource | undefined {
    const { id, live } = params;

    return (
      this.#store && {
        reader: this.#store.outputs(id),
        follow: (follow) => live.harness.tasks.followOutput(follow),
      }
    );
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
      if (!stored.has(channel)) throw noSuchChannel();
    }

    for (const { channel, from } of request.subscriptions) {
      const log = store?.channel({ id, channel });
      const kind = log && (await kindOf(log));

      if (!log || !kind) throw noSuchChannel();

      checkPosition({ from, kind });

      // Only a command's or a service's channel, which counts bytes, has output to read.
      const output = kind === 'byte' ? await outputRefOf({ log, channel }) : undefined;

      channels.push({ channel, from, log, kind, output });
    }

    return channels;
  }
}

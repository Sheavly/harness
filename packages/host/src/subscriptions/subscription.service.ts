import type { NodeChannelWriter } from '@sheavly/runtime/nodes/node-channel-writer.service';
import type { ChannelEvent } from '@sheavly/runtime/nodes/nodes.types';
import type {
  ChannelEndFrame,
  ChannelName,
  SubscribeFrame,
} from '@sheavly/protocol/subscription/subscription.types';
import { FrameQueue } from './frame-queue.service.js';
import type { HeldBytes } from './held-bytes.service.js';
import { readSelection, tooMuchHeld } from './subscription-read.helper.js';
import {
  bytesOfFrame,
  cursorOfFrame,
  endFrame,
  entryFrame,
  headFrame,
} from './subscription-frames.utils.js';
import { MAX_QUEUED_FRAMES } from './subscriptions.constants.js';
import type { ChannelState, ResolvedChannel, Selection } from './subscriptions.types.js';

/**
 * One subscribe request being served: the stored history of each of its channels, then what the
 * writer stores from then on, as frames in the order a client reads them. It follows each channel
 * before it reads the store, so nothing written in between is missed, and the place each told entry
 * has in its log (`ordinal`) drops the ones the read already held, so none is sent twice.
 *
 * A channel ends on its own (`end`): its `closed` entry was sent (`completed`), the consumer did
 * not keep up, or held more than the conversation may (`cut_off`, and only that channel stops: its
 * client resumes from the cursor in the frame), or nothing more will be written to it (`failed`: its
 * storage failed, or no writer has it). The frames end when every channel has. `close` stops it at
 * any time, and must be called when the consumer is done, whether it read the frames or not.
 *
 * The frames it holds for its consumer count against `pool`, the bytes all of a conversation's
 * subscriptions may hold: history that does not fit refuses the subscription, and live frames that
 * do not fit cut their channel off. A frame is given back when it is read, and all that waits when
 * the subscription closes.
 */
export class Subscription {
  readonly #writer: NodeChannelWriter | undefined;
  readonly #pool: HeldBytes;
  readonly #queue = new FrameQueue();
  readonly #states = new Map<string, ChannelState>();
  readonly #onClose: () => void;
  /** What the reads of history hold of the pool, until their entries are queued as frames. */
  #readHeld = 0;
  #closed = false;

  constructor(params: {
    writer: NodeChannelWriter | undefined;
    pool: HeldBytes;
    onClose: () => void;
  }) {
    this.#writer = params.writer;
    this.#pool = params.pool;
    this.#onClose = params.onClose;
  }

  /**
   * Opens a subscription to `channels`, whose positions were checked, reading their stored history
   * against `budget` (the request's whole read) and holding it against `pool`. An aborted `signal`
   * stops the read. Rejects with what the read rejects with, or `too_many_subscriptions` when the
   * history does not fit in `pool`, and has then released everything it held.
   */
  static async open(params: {
    writer: NodeChannelWriter | undefined;
    channels: readonly ResolvedChannel[];
    budget: { left: number };
    pool: HeldBytes;
    signal?: AbortSignal | undefined;
    onClose: () => void;
  }): Promise<Subscription> {
    const subscription = new Subscription(params);

    try {
      await subscription.#start(params);
    } catch (caughtError) {
      subscription.close();
      throw caughtError;
    }

    return subscription;
  }

  /** The frames, until every channel has ended or `close` is called. */
  async *frames(): AsyncGenerator<SubscribeFrame> {
    try {
      while (!this.#closed) {
        const frame = this.#take();

        if (frame) {
          yield frame;
          continue;
        }

        if ([...this.#states.values()].every((state) => state.ended)) return;

        await this.#queue.wait();
      }
    } finally {
      this.close();
    }
  }

  /** The next frame, noting the cursor it brings its channel to: where a cut-off one resumes. */
  #take(): SubscribeFrame | undefined {
    const item = this.#queue.shift();

    if (!item) return undefined;

    const state = this.#states.get(item.channel);
    const cursor = cursorOfFrame(item.frame);

    this.#pool.give(item.bytes);

    if (state && cursor !== undefined) state.delivered = cursor;

    return item.frame;
  }

  /** Stops following every channel and gives back what the subscription held. Safe to repeat. */
  close(): void {
    if (this.#closed) return;

    this.#closed = true;

    for (const state of this.#states.values()) state.stop();

    this.#pool.give(this.#queue.clear() + this.#readHeld);
    this.#readHeld = 0;
    this.#queue.notify();
    this.#onClose();
  }

  async #start(params: {
    channels: readonly ResolvedChannel[];
    budget: { left: number };
    signal?: AbortSignal | undefined;
  }): Promise<void> {
    const { channels, budget, signal } = params;
    const selections = new Map<string, Selection>();

    // Following comes first: an entry stored while the store is read is told, and is joined after.
    for (const { channel } of channels) this.#follow(channel);

    for (const { channel, log, from, kind } of channels) {
      const pool = this.#pool;
      const selection = await readSelection({ log, from, kind, budget, pool, signal });

      this.#readHeld += selection.held;
      selections.set(channel, selection);
    }

    for (const resolved of channels) {
      const selection = selections.get(resolved.channel);

      if (selection) this.#join({ resolved, selection });
    }
  }

  #follow(channel: ChannelName): void {
    const stop =
      this.#writer?.follow({ channel, listener: (event) => this.#hear({ channel, event }) }) ??
      (() => undefined);

    this.#states.set(channel, {
      stop,
      early: [],
      overflowed: false,
      acceptFrom: 0,
      ended: false,
      delivered: undefined,
    });
  }

  /** Puts one channel's history on the queue, then what was told while it was read. */
  #join(params: { resolved: ResolvedChannel; selection: Selection }): void {
    const { resolved, selection } = params;
    const { channel, from } = resolved;
    const state = this.#states.get(channel);

    // The entries become frames, which are charged as they are queued: the read's hold ends here.
    this.#pool.give(selection.held);
    this.#readHeld -= selection.held;

    if (!state) return;

    state.acceptFrom = selection.count;

    if (from === 'now') {
      const frame = headFrame({ channel, cursor: selection.newest.cursor });

      this.#enqueue({ channel, frame, live: false });
    }

    for (const entry of selection.entries) {
      const frame = entryFrame(entry);

      if (!frame) {
        this.#end({ channel, reason: 'failed' });

        return;
      }

      // History is not cut: a request it does not fit is refused, as one more than can be served.
      if (!this.#enqueue({ channel, frame, live: false })) throw tooMuchHeld();
    }

    if (selection.newest.type === 'closed') {
      this.#end({ channel, reason: 'completed' });

      return;
    }

    const early = state.early ?? [];

    state.early = undefined;

    if (state.overflowed) {
      this.#end({ channel, reason: 'cut_off' });

      return;
    }

    for (const event of early) this.#hear({ channel, event });

    // Nothing will be written to a channel its writer does not have: waiting would be for good.
    if (!state.ended && this.#writer?.writing(channel) !== true) {
      this.#end({ channel, reason: 'failed' });
    }
  }

  /** What the writer told about `channel`. Never throws: it runs inside the writer's own call. */
  #hear(params: { channel: ChannelName; event: ChannelEvent }): void {
    const { channel, event } = params;
    const state = this.#states.get(channel);

    if (!state || state.ended || this.#closed) return;

    if (state.early !== undefined) {
      // Still reading the store: keep what is told, up to what a subscription holds.
      if (state.early.length >= MAX_QUEUED_FRAMES) state.overflowed = true;
      else state.early.push(event);

      return;
    }

    if (event.type === 'failed') {
      this.#end({ channel, reason: 'failed' });

      return;
    }

    if (event.ordinal < state.acceptFrom) return;

    const frame = entryFrame(event.entry);

    if (!frame) {
      this.#end({ channel, reason: 'failed' });
    } else if (!this.#enqueueLive({ channel, frame })) {
      this.#end({ channel, reason: 'cut_off' });
    } else if (frame.type === 'closed') {
      this.#end({ channel, reason: 'completed' });
    }
  }

  /** Queues a frame of `channel`, counted against the pool; false, queuing nothing, if it does not fit. */
  #enqueue(params: { channel: ChannelName; frame: SubscribeFrame; live: boolean }): boolean {
    const bytes = bytesOfFrame(params.frame);

    if (!this.#pool.take(bytes)) return false;

    this.#queue.push({ ...params, bytes });

    return true;
  }

  /** Queues a live frame, unless its channel already has as many waiting as a consumer may leave. */
  #enqueueLive(params: { channel: ChannelName; frame: SubscribeFrame }): boolean {
    if (this.#queue.liveQueued(params.channel) >= MAX_QUEUED_FRAMES) return false;

    return this.#enqueue({ ...params, live: true });
  }

  /**
   * Ends `channel` for this subscription. A cut-off consumer will not get the live frames that
   * wait, so its cursor is that of the newest frame it will still get, which it resumes after.
   */
  #end(params: { channel: ChannelName; reason: ChannelEndFrame['reason'] }): void {
    const { channel, reason } = params;
    const state = this.#states.get(channel);

    if (!state || state.ended) return;

    state.ended = true;
    state.stop();

    if (reason === 'cut_off') this.#pool.give(this.#queue.dropLive(channel));

    const cursor = this.#queue.lastCursor(channel) ?? state.delivered;
    const frame = endFrame({ channel, reason, cursor });

    this.#enqueue({ channel, frame, live: false });
  }
}

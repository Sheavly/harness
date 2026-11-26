import type { ConversationChannels } from '@sheavly/runtime/nodes/conversation-channels.service';
import type { NodeChannelWriter } from '@sheavly/runtime/nodes/node-channel-writer.service';
import type { ChannelEvent } from '@sheavly/runtime/nodes/nodes.types';
import type { ChannelEntry } from '@sheavly/core/store/store.types';
import { isConversationChannel } from '@sheavly/protocol/channel/channel.utils';
import { nodeIdSchema } from '@sheavly/protocol/node/node.validator';
import type {
  ChannelEndFrame,
  ChannelName,
  SubscribeFrame,
} from '@sheavly/protocol/subscription/subscription.types';
import { FrameQueue } from './frame-queue.service.js';
import type { HeldBytes } from './held-bytes.service.js';
import { closedAt } from './output-chunks.utils.js';
import { readOutputSelection } from './output-selection.helper.js';
import { OutputTail } from './output-tail.service.js';
import { readSelection, snapshotSelection, tooMuchHeld } from './subscription-read.helper.js';
import {
  bytesOfFrame,
  cursorOfFrame,
  endFrame,
  entryFrame,
  headFrame,
} from './subscription-frames.utils.js';
import { MAX_QUEUED_FRAMES, OUTPUT_BATCH_MS } from './subscriptions.constants.js';
import type {
  ChannelState,
  OutputSource,
  ResolvedChannel,
  Selection,
  TailEnd,
} from './subscriptions.types.js';

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
  readonly #conversation: ConversationChannels | undefined;
  readonly #output: OutputSource | undefined;
  readonly #pool: HeldBytes;
  readonly #queue = new FrameQueue();
  readonly #states = new Map<string, ChannelState>();
  readonly #onClose: () => void;
  /** What the reads of history hold of the pool, until their entries are queued as frames. */
  #readHeld = 0;
  #closed = false;

  constructor(params: {
    writer: NodeChannelWriter | undefined;
    conversation?: ConversationChannels | undefined;
    output?: OutputSource | undefined;
    pool: HeldBytes;
    onClose: () => void;
  }) {
    this.#writer = params.writer;
    this.#conversation = params.conversation;
    this.#output = params.output;
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
    /** The conversation's own channels, which a channel of the conversation is followed through. */
    conversation?: ConversationChannels | undefined;
    /** Where a command's complete output is read and followed, for a channel that kept it. */
    output?: OutputSource | undefined;
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
    for (const resolved of channels) this.#follow(resolved);

    for (const resolved of channels) {
      const selection = await this.#select({ resolved, budget, signal });

      this.#readHeld += selection.held;
      selections.set(resolved.channel, selection);
    }

    for (const resolved of channels) {
      const selection = selections.get(resolved.channel);

      if (selection) this.#join({ resolved, selection });
    }
  }

  /** What the channel starts with: the tree as it stands, the output store's history, or the log's. */
  #select(params: {
    resolved: ResolvedChannel;
    budget: { left: number };
    signal?: AbortSignal | undefined;
  }): Promise<Selection> {
    const { resolved, budget, signal } = params;
    const { channel, log, from, kind, output } = resolved;
    const pool = this.#pool;

    if (from === 'snapshot') {
      return snapshotSelection({ channel: this.#conversation?.get(channel), name: channel });
    }

    if (output && this.#output) {
      const outputs = this.#output.reader;

      return readOutputSelection({
        channel,
        log,
        from,
        ref: output,
        outputs,
        budget,
        pool,
        signal,
      });
    }

    return readSelection({ log, from, kind, budget, pool, signal });
  }

  #follow(resolved: ResolvedChannel): void {
    const { channel } = resolved;
    const listener = (event: ChannelEvent) => this.#hear({ channel, event });
    const stopEntries =
      (isConversationChannel(channel)
        ? this.#conversation?.get(channel)?.follow(listener)
        : this.#writer?.follow({ channel, listener })) ?? (() => undefined);
    const tail = this.#tailOf(resolved);
    const stopOutput = tail && this.#followOutput({ channel, tail });

    this.#states.set(channel, {
      stop: () => {
        stopEntries();
        stopOutput?.();
        tail?.stop();
      },
      early: [],
      overflowed: false,
      acceptFrom: 0,
      ended: false,
      delivered: undefined,
      tail,
    });
  }

  /** The live output of a channel that kept it, which ends the channel when it can go no further. */
  #tailOf(resolved: ResolvedChannel): OutputTail | undefined {
    if (!resolved.output || !this.#output) return undefined;

    const { channel } = resolved;

    return new OutputTail({
      channel,
      delayMs: OUTPUT_BATCH_MS,
      emit: (entry) => this.#emitOutput({ channel, entry }),
      onEnd: (reason) => this.#end({ channel, reason }),
    });
  }

  /** Follows the capture of the command `channel` is, if it still runs; the tail hears each chunk. */
  #followOutput(params: { channel: ChannelName; tail: OutputTail }): (() => void) | undefined {
    return this.#output?.follow({
      nodeId: nodeIdSchema.parse(params.channel),
      listener: (chunk) => params.tail.hear(chunk),
    });
  }

  /** Queues an output entry as a live frame: nothing if it did, or why the channel must end. */
  #emitOutput(params: { channel: ChannelName; entry: ChannelEntry }): TailEnd | undefined {
    const frame = entryFrame(params.entry);

    if (!frame) return 'failed';

    return this.#enqueueLive({ channel: params.channel, frame }) ? undefined : 'cut_off';
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

    // The tree as it stands comes first; the entries after its cursor are the live ones below.
    if (selection.snapshot && !this.#enqueue({ channel, frame: selection.snapshot, live: false })) {
      throw tooMuchHeld();
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

    // The output that was stored while the history was read joins it by offset, before the writer's
    // own `closed` event, which follows all of it.
    state.tail?.join(selection.outputEnd ?? 0);

    if (state.ended) return;

    const early = state.early ?? [];

    state.early = undefined;

    if (state.overflowed) {
      this.#end({ channel, reason: 'cut_off' });

      return;
    }

    for (const event of early) this.#hear({ channel, event });

    // Nothing will be written to a channel its writer does not have: waiting would be for good.
    if (!state.ended && !this.#writing(channel)) {
      this.#end({ channel, reason: 'failed' });
    }
  }

  /** Whether a writer may still write `channel`: a node's channel's, or the conversation channel's own. */
  #writing(channel: ChannelName): boolean {
    if (isConversationChannel(channel)) return this.#conversation?.get(channel)?.writing() === true;

    return this.#writer?.writing(channel) === true;
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

    const entry = this.#afterOutput({ state, entry: event.entry });

    // Sending what waited can end the channel (the consumer is too slow for it).
    if (state.ended) return;

    const frame = entryFrame(entry);

    if (!frame) {
      this.#end({ channel, reason: 'failed' });
    } else if (!this.#enqueueLive({ channel, frame })) {
      this.#end({ channel, reason: 'cut_off' });
    } else if (frame.type === 'closed') {
      this.#end({ channel, reason: 'completed' });
    }
  }

  /**
   * The entry a channel's writer told, for a channel with output: a `closed` entry comes after all
   * of the output (what waits to be batched is sent first), and stands where the output ended. The
   * capture closes before the node ends, so every chunk was told before this entry.
   */
  #afterOutput(params: { state: ChannelState; entry: ChannelEntry }): ChannelEntry {
    const { state, entry } = params;

    if (!state.tail || entry.type !== 'closed') return entry;

    state.tail.flush();

    return closedAt({ entry, end: state.tail.taken });
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

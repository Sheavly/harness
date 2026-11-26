import { cursorKind, cursorNumber } from '@sheavly/protocol/channel/channel.utils';
import type {
  ChannelEndFrame,
  SubscribeFrame,
  SubscribeRequest,
} from '@sheavly/protocol/subscription/subscription.types';

/** What the client holds of one channel it follows. */
type ChannelProgress = {
  /** Where it was asked to start, used until a frame gives it a cursor. */
  from: string;
  /** The cursor of the last frame delivered for it. */
  cursor: string | undefined;
  /** No more frames of it will come (`completed` or `failed`). */
  ended: boolean;
  /** Its `closed` entry was delivered. */
  closed: boolean;
  /** The server cut it off for this connection: it is asked again from its cursor. */
  cutOff: boolean;
};

/** Whether `cursor` is past `last` in its channel; cursors of two kinds are never compared. */
function isAfter(params: { cursor: string; last: string }): boolean {
  const { cursor, last } = params;

  return cursorKind(cursor) !== cursorKind(last) || cursorNumber(cursor) > cursorNumber(last);
}

/**
 * What a subscription has delivered, per channel: the cursor of the last frame, whether the channel
 * ended, and so what a reconnect asks for (each channel that has not ended, from its cursor, or
 * from where it was first asked when nothing came of it) and which frame a connection that resumed
 * delivers again, so none reaches the reader twice.
 *
 * A byte cursor is where the output stood, and a channel's `closed` entry carries the cursor of the
 * output before it, so it is the one entry that is new at a cursor that is not past the last one.
 */
export class SubscribeProgress {
  readonly #channels = new Map<string, ChannelProgress>();

  constructor(subscriptions: SubscribeRequest['subscriptions']) {
    for (const { channel, from } of subscriptions) {
      this.#channels.set(channel, {
        from,
        cursor: undefined,
        ended: false,
        closed: false,
        cutOff: false,
      });
    }
  }

  /** Every channel has ended: nothing more will come. */
  get finished(): boolean {
    return [...this.#channels.values()].every(({ ended }) => ended);
  }

  /** A channel was cut off on this connection, which is to be left and opened again. */
  get cutOff(): boolean {
    return [...this.#channels.values()].some(({ cutOff }) => cutOff);
  }

  /**
   * The channels the next connection asks for: those that have not ended, each from the cursor of its
   * last frame. Calling it starts that connection, so a cut-off channel is no longer waiting.
   */
  nextRequest(): { channel: string; from: string }[] {
    const wanted: { channel: string; from: string }[] = [];

    for (const [channel, progress] of this.#channels) {
      progress.cutOff = false;

      if (!progress.ended) wanted.push({ channel, from: progress.cursor ?? progress.from });
    }

    return wanted;
  }

  /**
   * Takes `frame` in, and returns it when the reader is to see it: a frame already delivered (the
   * connection resumed a little before the cursor), a frame of a channel that was not asked for and
   * a cut-off (the client's to handle, not the reader's) are not returned.
   */
  accept(frame: SubscribeFrame): SubscribeFrame | undefined {
    const progress = this.#channels.get(frame.channel);

    if (!progress) return undefined;

    if (frame.type === 'end') return this.#end({ progress, frame });

    if (frame.type === 'snapshot') {
      progress.cursor = frame.cursor;

      return frame;
    }

    if (frame.type === 'head') return this.#moveTo({ progress, frame, closes: false });

    return this.#moveTo({ progress, frame, closes: frame.type === 'closed' });
  }

  /** A channel ended: for good, or only on this connection (`cut_off`, which the reader never sees). */
  #end(params: { progress: ChannelProgress; frame: ChannelEndFrame }): ChannelEndFrame | undefined {
    const { progress, frame } = params;
    const { cursor } = frame;

    // Only forward: a cursor before what was delivered would make the next connection send it again.
    if (
      cursor !== undefined &&
      (progress.cursor === undefined || isAfter({ cursor, last: progress.cursor }))
    ) {
      progress.cursor = cursor;
    }

    if (frame.reason === 'cut_off') {
      progress.cutOff = true;

      return undefined;
    }

    progress.ended = true;

    return frame;
  }

  /** Moves the channel to the cursor of `frame` when it is new, and returns it; else nothing. */
  #moveTo<T extends { cursor: string }>(params: {
    progress: ChannelProgress;
    frame: T;
    closes: boolean;
  }): T | undefined {
    const { progress, frame, closes } = params;
    const { cursor } = progress;
    const delivered =
      cursor !== undefined &&
      !isAfter({ cursor: frame.cursor, last: cursor }) &&
      !(closes && cursorKind(frame.cursor) === 'byte' && !progress.closed);

    if (delivered) return undefined;

    progress.cursor = frame.cursor;
    if (closes) progress.closed = true;

    return frame;
  }
}

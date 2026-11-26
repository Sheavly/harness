import type { SubscribeFrame } from '@sheavly/protocol/subscription/subscription.types';
import { ChannelFailedError, RefusedError } from '../errors/client.errors.js';
import type { FollowedView, FollowViewParams } from './follow-view.types.js';
import { subscribeChannels } from './subscribe.helper.js';

/** The server no longer holds the position the client resumed from: it asks for the view afresh. */
const isOutOfRange = (error: unknown) =>
  error instanceof RefusedError && error.code === 'cursor_out_of_range';

/**
 * Follows a conversation's own channel as a view: the snapshot first, then the channel's entries
 * after it, so `view()` is the view as it stands and `onChange` is told each time it changes (not
 * for a frame that changes nothing in it). A dropped connection resumes after the last entry
 * (`subscribeChannels`), which gives the view the snapshot of that moment would; a position the
 * server no longer holds (`cursor_out_of_range`) is asked for again from `snapshot`, which replaces
 * the view. Resolves once the server has accepted the first connection.
 *
 * `ended` rejects with `ChannelFailedError` when the channel ends `failed` (storing it failed, or its
 * conversation closed: nothing more will come, and an approvals claim is gone), with a refusal, and
 * with whatever `fold` or `onChange` throws; it resolves when the channel ends `completed` and when
 * `signal` aborts, which ends it quietly.
 */
export async function followChannelView<View>(
  params: FollowViewParams<View>,
): Promise<FollowedView<View>> {
  const { client, id, channel, fold, onChange, signal, approvals } = params;
  let view = params.empty;
  const open = (from: string) =>
    subscribeChannels({
      client,
      id,
      subscriptions: [{ channel, from }],
      signal,
      ...(approvals !== undefined && { approvals }),
    });
  const follow = async (frames: AsyncGenerator<SubscribeFrame>): Promise<void> => {
    for await (const frame of frames) {
      // The channel failed: storing it failed, or its conversation closed. What was read is not all
      // of it, and the connection, with a claim to answer approvals, is gone: a UI must be told.
      if (frame.type === 'end' && frame.reason === 'failed') {
        throw new ChannelFailedError({ channel });
      }

      const next = fold({ view, frame });

      if (next === view) continue;

      view = next;
      onChange(view);
    }
  };
  const run = async (first: AsyncGenerator<SubscribeFrame>): Promise<void> => {
    let frames = first;

    for (;;) {
      try {
        await follow(frames);

        return;
      } catch (caughtError) {
        if (signal.aborted) return;

        if (!isOutOfRange(caughtError)) throw caughtError;
      }

      // The server no longer holds the position: the view is asked for afresh. An abort while it is
      // being opened is the caller leaving, not a failure.
      try {
        frames = await open('snapshot');
      } catch (caughtError) {
        if (signal.aborted) return;

        throw caughtError;
      }
    }
  };

  return { view: () => view, ended: run(await open('snapshot')) };
}

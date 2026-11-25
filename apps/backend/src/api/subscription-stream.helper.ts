import type { Context } from 'hono';
import { streamSSE } from 'hono/streaming';
import { ENTRY_EVENT } from '@sheavly/protocol/api/api.constants';
import {
  END_EVENT,
  HEAD_EVENT,
  SNAPSHOT_EVENT,
} from '@sheavly/protocol/subscription/subscription.constants';
import type { SubscribeFrame } from '@sheavly/protocol/subscription/subscription.types';
import { HEARTBEAT_MS } from './api.constants.js';

/** What a subscription gives the server: its frames, and the way to let go of it. */
type FrameSource = {
  frames: () => AsyncIterable<SubscribeFrame>;
  close: () => void;
};

/**
 * The event name a frame travels under: `head`, `end` and `snapshot` for the frames that are not
 * entries, else `entry`.
 */
function eventOf(frame: SubscribeFrame): string {
  if (frame.type === HEAD_EVENT || frame.type === END_EVENT || frame.type === SNAPSHOT_EVENT) {
    return frame.type;
  }

  return ENTRY_EVENT;
}

/**
 * A subscription's frames as server-sent events, one `data` JSON per frame under its event name
 * (`entry`, `head`, `end` or `snapshot`) and no `id`: one id cannot carry the cursors of several channels, so
 * a client keeps each channel's last cursor and sends them again on a reconnect. The stream ends
 * when the subscription does (every channel ended) or when the client leaves, and the subscription
 * is closed either way, so the connection it held is free again. A heartbeat comment keeps a quiet
 * stream open through proxies.
 */
export function streamSubscription(params: { c: Context; subscription: FrameSource }) {
  const { c, subscription } = params;
  const gone = c.req.raw.signal;
  const close = () => {
    subscription.close();
  };

  c.header('X-Accel-Buffering', 'no'); // a buffering proxy (nginx) would hold events back

  try {
    return streamSSE(c, async (stream) => {
      const heartbeat = setInterval(() => void stream.write(': heartbeat\n\n'), HEARTBEAT_MS);

      stream.onAbort(close);
      // A client that left while its history was being read is gone before there is a stream for
      // it: the stream's own abort never fires for it, the request's signal has already.
      gone.addEventListener('abort', close, { once: true });

      if (gone.aborted) close();

      try {
        for await (const frame of subscription.frames()) {
          await stream.writeSSE({ event: eventOf(frame), data: JSON.stringify(frame) });
        }
      } finally {
        clearInterval(heartbeat);
        gone.removeEventListener('abort', close);
        close();
      }
    });
  } catch (caughtError) {
    // The stream was never built, so nothing above will close what the caller opened.
    close();
    throw caughtError;
  }
}

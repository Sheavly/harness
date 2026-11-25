import type { SubscribeFrame } from '@sheavly/protocol/subscription/subscription.types';
import { subscribeFrameSchema } from '@sheavly/protocol/subscription/subscription.validator';

/**
 * Test-only: the text of each server-sent frame of `body`, as it ends. The client's own reader keeps
 * only the frames of the conversation stream, which have an `id`; a subscribe stream's have none, so
 * a test reads them here.
 */
async function* rawFrames(body: ReadableStream<Uint8Array>) {
  const decoder = new TextDecoder();
  let buffered = '';

  for await (const chunk of body) {
    buffered += decoder.decode(chunk, { stream: true });

    for (let end = buffered.indexOf('\n\n'); end !== -1; end = buffered.indexOf('\n\n')) {
      yield buffered.slice(0, end);
      buffered = buffered.slice(end + 2);
    }
  }
}

/** Test-only: the frames of a subscribe stream's body, one at a time, as a client reads them. */
export function framesOf(body: ReadableStream<Uint8Array>) {
  const frames = rawFrames(body);

  return async (): Promise<{ event: string; frame: SubscribeFrame } | undefined> => {
    for (;;) {
      const next = await frames.next();

      if (next.done) return undefined;

      const lines = next.value.split('\n');
      const event = lines.find((each) => each.startsWith('event: '));
      const data = lines.find((each) => each.startsWith('data: '));

      // A heartbeat comment is neither.
      if (!event || !data) continue;

      const parsed: unknown = JSON.parse(data.slice('data: '.length));

      return { event: event.slice('event: '.length), frame: subscribeFrameSchema.parse(parsed) };
    }
  };
}

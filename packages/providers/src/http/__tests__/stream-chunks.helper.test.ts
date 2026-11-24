import { describe, expect, it } from 'vitest';
import { ConnectionLostError } from '@sheavly/core/errors/connection.errors';
import { collect } from '@sheavly/testing/fetch/fake-fetch.fake';
import { readReply } from '../reply-reader.helper.js';
import { streamChunks } from '../stream-chunks.helper.js';

const bytes = (text: string) => new TextEncoder().encode(text);

/** A body that sends `chunks`, then stays silent (or fails with `then`) until it is cancelled. */
function body(params: { chunks: string[]; then?: 'silence' | Error; onCancel?: () => void }) {
  const { chunks, then = 'silence', onCancel } = params;
  const pending = [...chunks];

  return new ReadableStream<Uint8Array>({
    cancel() {
      onCancel?.();
    },
    pull(controller) {
      const next = pending.shift();

      if (next !== undefined) {
        controller.enqueue(bytes(next));

        return;
      }

      if (then instanceof Error) {
        controller.error(then);

        return;
      }

      // Never answers: a connection that died without saying so.
      return new Promise<void>(() => undefined);
    },
  });
}

const listen = (
  stream: ReadableStream<Uint8Array>,
  idleMs = 20,
  signal = new AbortController().signal,
) => collect(streamChunks({ body: stream, idleMs, signal }));

describe('the chunks of a reply', () => {
  it('are passed on as they come, until the body ends', async () => {
    const ended = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(bytes('a'));
        controller.enqueue(bytes('b'));
        controller.close();
      },
    });
    const chunks = await listen(ended);

    expect(chunks.map((chunk) => new TextDecoder().decode(chunk))).toEqual(['a', 'b']);
  });

  it('end in a ConnectionLostError when the connection breaks, keeping the cause and its code', async () => {
    const reset = new TypeError('terminated', {
      cause: Object.assign(new Error('other side closed'), { code: 'UND_ERR_SOCKET' }),
    });
    const lost = await listen(body({ chunks: ['a'], then: reset })).catch(
      (caughtError: unknown) => caughtError,
    );

    expect(lost).toBeInstanceOf(ConnectionLostError);
    expect(lost).toMatchObject({ reason: 'dropped', cause: reset });
    expect((lost as Error).message).toContain('UND_ERR_SOCKET');
  });

  it('end in a ConnectionLostError when the body goes silent for too long', async () => {
    const lost = await listen(body({ chunks: ['a'] }), 20).catch(
      (caughtError: unknown) => caughtError,
    );

    expect(lost).toBeInstanceOf(ConnectionLostError);
    expect(lost).toMatchObject({ reason: 'idle' });
  });

  it('cancel a body that went silent, so its socket and its pending read are not kept', async () => {
    let cancelled = false;

    await listen(
      body({
        chunks: ['a'],
        onCancel: () => {
          cancelled = true;
        },
      }),
      20,
    ).catch((caughtError: unknown) => caughtError);

    expect(cancelled).toBe(true);
  });

  it('cancel the body when the reader stops before its end', async () => {
    let cancelled = false;
    const chunks = streamChunks({
      body: body({
        chunks: ['a', 'b'],
        onCancel: () => {
          cancelled = true;
        },
      }),
      idleMs: 1000,
      signal: new AbortController().signal,
    });

    for await (const chunk of chunks) {
      expect(chunk).toBeDefined();
      break;
    }

    expect(cancelled).toBe(true);
  });

  it('are not a lost connection when the caller interrupted: that goes up as it came', async () => {
    const controller = new AbortController();
    const stop = new Error('stop');

    // A fetch body rejects with the signal's reason once the signal aborts.
    controller.abort(stop);

    const outcome = await listen(body({ chunks: [], then: stop }), 5000, controller.signal).catch(
      (caughtError: unknown) => caughtError,
    );

    expect(outcome).toBe(stop);
  });
});

describe('readReply on a body that goes silent', () => {
  it('throws the ConnectionLostError after the events it had already read, never a cut_off', async () => {
    const events: string[] = [];
    const protocol = {
      cutOffMessage: 'cut off',
      parse: (raw: unknown) => raw as { text: string },
      step: (event: { text: string }) => ({
        events: [{ type: 'text_delta' as const, text: event.text }],
      }),
      finish: () => [],
    };
    const reading = (async () => {
      for await (const event of readReply({
        body: body({ chunks: ['data: {"text":"par"}\n\n'] }),
        signal: new AbortController().signal,
        protocol,
        idleMs: 20,
      })) {
        events.push(event.type === 'text_delta' ? event.text : event.type);
      }
    })();

    await expect(reading).rejects.toBeInstanceOf(ConnectionLostError);
    expect(events).toEqual(['par']);
  });

  it('keeps a reply whole that sent its end marker before the connection went silent', async () => {
    const events: string[] = [];
    const protocol = {
      cutOffMessage: 'cut off',
      parse: (raw: unknown) => raw as { text: string; end?: true },
      step: (event: { text: string; end?: true }) => ({
        events: [{ type: 'text_delta' as const, text: event.text }],
        ...(event.end && { ended: true as const }),
      }),
      finish: () => [{ type: 'done' as const, stopReason: 'end_turn' as const }],
    };

    for await (const event of readReply({
      body: body({ chunks: ['data: {"text":"all","end":true}\n\n'] }),
      signal: new AbortController().signal,
      protocol,
      idleMs: 20,
    })) {
      events.push(event.type === 'text_delta' ? event.text : event.type);
    }

    expect(events).toEqual(['all', 'done']);
  });
});

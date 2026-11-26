import { describe, expect, it } from 'vitest';
import { AnswerTooLargeError } from '../../errors/client.errors.js';
import { readSseFrames } from '../sse.helper.js';

/** A body that sends `chunks` as they are, one after the other. */
function bodyOf(chunks: string[]): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();

  return new ReadableStream({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));

      controller.close();
    },
  });
}

async function framesOf(params: { chunks: string[]; maxFrameChars?: number }) {
  const frames = [];

  for await (const frame of readSseFrames({
    body: bodyOf(params.chunks),
    route: 'streamChannels',
    ...(params.maxFrameChars !== undefined && { maxFrameChars: params.maxFrameChars }),
  })) {
    frames.push(frame);
  }

  return frames;
}

describe('readSseFrames', () => {
  it('gives each frame its event, id and data, and nothing for a line it does not have', async () => {
    const frames = await framesOf({
      chunks: ['event: entry\nid: 4\ndata: {"a":1}\n\nevent: head\ndata: {}\n\nid: 9\n\n'],
    });

    expect(frames).toEqual([
      { event: 'entry', cursor: '4', data: '{"a":1}' },
      { event: 'head', cursor: undefined, data: '{}' },
      { event: undefined, cursor: '9', data: undefined },
    ]);
  });

  it('puts a frame together from chunks that cut it anywhere, CRLF line ends and a split character included', async () => {
    const bytes = new TextEncoder().encode('event: entry\r\ndata: "€"\r\n\r\n');
    const euro = bytes.indexOf(0xe2);
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(bytes.slice(0, euro + 1));
        controller.enqueue(bytes.slice(euro + 1));
        controller.close();
      },
    });
    const frames = [];

    for await (const frame of readSseFrames({ body, route: 'streamChannels' })) frames.push(frame);

    expect(frames).toEqual([{ event: 'entry', cursor: undefined, data: '"€"' }]);
  });

  it('finds the blank line that ends a frame wherever the chunks cut it, one byte at a time included', async () => {
    const text = 'event: entry\nid: 1\ndata: {"a":1}\n\nevent: end\ndata: 2\n\n';
    const expected = [
      { event: 'entry', cursor: '1', data: '{"a":1}' },
      { event: 'end', cursor: undefined, data: '2' },
    ];

    const oneEach = Array.from({ length: text.length }, (_, index) => text.charAt(index));

    expect(await framesOf({ chunks: oneEach })).toEqual(expected);
    // Cut between the two newlines of the first blank line.
    expect(await framesOf({ chunks: [text.slice(0, 33), text.slice(33)] })).toEqual(expected);
  });

  it('reads a frame of many small chunks in time that does not grow with each chunk', async () => {
    // 2 MiB in 1 KiB chunks: scanning all of it again for each chunk would be 2,000 passes over it.
    const data = 'x'.repeat(2 * 1024 * 1024);
    const text = `event: entry\ndata: ${data}\n\n`;
    const chunks = Array.from({ length: Math.ceil(text.length / 1024) }, (_, index) =>
      text.slice(index * 1024, (index + 1) * 1024),
    );
    const started = performance.now();
    const frames = await framesOf({ chunks });

    expect(frames).toHaveLength(1);
    expect(frames[0]?.data).toHaveLength(data.length);
    expect(performance.now() - started).toBeLessThan(2_000);
  });

  it('reads a frame that comes a character at a time whole, a line break inside it and pieces joined along the way', async () => {
    // Over a hundred joins of a thousand pieces each, and a single newline in the middle of it.
    const data = 'ab'.repeat(100_000);
    const text = `event: entry\ndata: ${data}\nid: 7\n\n`;
    const oneEach = Array.from({ length: text.length }, (_, index) => text.charAt(index));
    const frames = await framesOf({ chunks: oneEach });

    expect(frames).toEqual([{ event: 'entry', cursor: '7', data }]);
  });

  it('joins pieces without losing or doubling a character wherever a line break or the end of the frame falls against a join', async () => {
    const oneEach = (text: string) =>
      Array.from({ length: text.length }, (_, index) => text.charAt(index));

    // The join happens at every 1,024th piece: put a single newline, and the end of the frame, on
    // each side of it ("data: " is six pieces).
    for (let length = 1_010; length <= 1_040; length += 1) {
      const data = 'x'.repeat(length);

      expect(await framesOf({ chunks: oneEach(`data: ${data}\nid: 5\n\n`) })).toEqual([
        { event: undefined, cursor: '5', data },
      ]);
      expect(await framesOf({ chunks: oneEach(`data: ${data}\n\ndata: next\n\n`) })).toEqual([
        { event: undefined, cursor: undefined, data },
        { event: undefined, cursor: undefined, data: 'next' },
      ]);
    }
  });

  it('counts a line break inside a frame once for the bound, though it waits for the next chunk', async () => {
    // 22 characters, a line break after 8 and after 14, one chunk for each: and the first newline
    // of the blank line, which waits, makes 23 held.
    const text = 'event: a\nid: b\ndata: c\n\n';
    const chunks = Array.from({ length: text.length }, (_, index) => text.charAt(index));

    expect(await framesOf({ chunks, maxFrameChars: 23 })).toEqual([
      { event: 'a', cursor: 'b', data: 'c' },
    ]);
    await expect(framesOf({ chunks, maxFrameChars: 21 })).rejects.toBeInstanceOf(
      AnswerTooLargeError,
    );
  });

  it('skips a comment, which is a heartbeat and no frame', async () => {
    expect(
      await framesOf({ chunks: [': heartbeat\n\nevent: end\ndata: 1\n\n: again\n\n'] }),
    ).toEqual([{ event: 'end', cursor: undefined, data: '1' }]);
  });

  it('refuses a frame that grows past the bound before it ends, and reads no more of it', async () => {
    const chunks = ['event: entry\ndata: ', 'x'.repeat(40), 'y'.repeat(40), '\n\n'];

    await expect(framesOf({ chunks, maxFrameChars: 64 })).rejects.toBeInstanceOf(
      AnswerTooLargeError,
    );
    // The same frames are read whole with no bound.
    expect(await framesOf({ chunks })).toHaveLength(1);
  });

  it('counts the bound for one frame, not for the stream: many small frames are read', async () => {
    const frame = 'event: entry\ndata: ok\n\n';
    const frames = await framesOf({
      chunks: Array.from({ length: 50 }, () => frame),
      maxFrameChars: 64,
    });

    expect(frames).toHaveLength(50);
  });
});

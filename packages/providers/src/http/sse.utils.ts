import { providerErrorText } from '@sheavly/core/text/diagnostic-text.utils';
import { ModelApiError } from '../errors/providers.errors.js';
import { LINE_BREAK } from './http.constants.js';

/**
 * Minimal Server-Sent Events reader: yields the parsed JSON of each `data:` block.
 * Lines may end in `\r\n`, `\n` or `\r`, split anywhere across network chunks. A last event the
 * body ends without a blank line after is still yielded, so a final event isn't lost.
 * Payloads are returned as `unknown`; callers validate them with zod.
 */
export async function* readServerSentEvents(body: AsyncIterable<Uint8Array>): AsyncGenerator {
  let data: string[] = [];

  for await (const line of readLines(body)) {
    if (line.startsWith('data:')) data.push(line.slice(5).trimStart());
    if (line !== '') continue;

    yield* parseData({ data });
    data = [];
  }

  yield* parseData({ data, atEnd: true });
}

/**
 * `atEnd`: the data the body ended with, no blank line after it. If it isn't JSON, the body was cut
 * off mid-payload: that unfinished event is discarded (as the SSE spec does), and the caller sees a
 * stream that ended without its final event.
 */
function* parseData(params: { data: string[]; atEnd?: boolean }): Generator {
  const { data, atEnd = false } = params;
  const payload = data.join('\n');

  if (!payload || payload === '[DONE]') return;

  let parsed: unknown;

  try {
    parsed = JSON.parse(payload);
  } catch (caughtError) {
    if (atEnd && caughtError instanceof SyntaxError) return;

    throw new ModelApiError({
      reason: 'bad_payload',
      message: `SSE stream sent a data payload that isn't JSON: ${providerErrorText(payload.slice(0, 200))}`,
      cause: caughtError,
    });
  }

  yield parsed;
}

async function* readLines(body: AsyncIterable<Uint8Array>): AsyncGenerator<string> {
  const reader = createLineReader();

  for await (const bytes of body) yield* reader.read(bytes);

  yield* reader.end();
}

/**
 * Turns chunks into complete lines, keeping the unfinished last line for the next chunk. A chunk
 * ending in `\r` may be the first half of `\r\n`, so a `\n` opening the next chunk is dropped.
 * `end()` returns the unfinished last line, if any, once the body is done.
 */
function createLineReader() {
  const decoder = new TextDecoder();
  let partial = '';
  let afterCarriageReturn = false;

  const read = (bytes: Uint8Array): string[] => {
    const decoded = decoder.decode(bytes, { stream: true });

    if (!decoded) return [];

    const text = afterCarriageReturn && decoded.startsWith('\n') ? decoded.slice(1) : decoded;

    afterCarriageReturn = decoded.endsWith('\r');

    const lines = (partial + text).split(LINE_BREAK);

    partial = lines.pop() ?? '';

    return lines;
  };

  const end = (): string[] => {
    const last = partial + decoder.decode();

    partial = '';

    return last ? [last] : [];
  };

  return { read, end };
}

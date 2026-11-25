import type { ChannelEntry } from '@sheavly/core/store/store.types';
import { cursorNumber } from '@sheavly/protocol/channel/channel.utils';
import { CONTINUATION_BITS, CONTINUATION_PATTERN } from './subscriptions.constants.js';

/** The cursor of a command's or a service's output at `offset` bytes. */
export const outputCursor = (offset: number): string => `b${String(offset)}`;

/** How many bytes `text` is as UTF-8: what a byte cursor counts, and what the output store holds. */
export const utf8Bytes = (text: string): number => Buffer.byteLength(text, 'utf8');

const continues = (byte: number | undefined) =>
  byte !== undefined && (byte & CONTINUATION_BITS) === CONTINUATION_PATTERN;

/**
 * An output entry of `channel`: `text`, which starts at byte `offset` of the output, and the cursor
 * after it. `at` is when the server made it: the output store does not keep when a byte was printed.
 */
export function outputEntry(params: {
  channel: string;
  offset: number;
  text: string;
  at: number;
}): ChannelEntry {
  const { channel, offset, text, at } = params;

  return {
    channel,
    cursor: outputCursor(offset + utf8Bytes(text)),
    at,
    type: 'output',
    offset,
    text,
  };
}

/**
 * `text` in pieces of at most `maxBytes` of UTF-8, each ending on a character boundary: a piece is
 * text a strict reader takes, and the offsets of the pieces add up to the bytes of `text`.
 * `maxBytes` is at least a character's four bytes, so every piece holds one.
 */
export function splitByBytes(params: { text: string; maxBytes: number }): string[] {
  const bytes = Buffer.from(params.text, 'utf8');
  const pieces: string[] = [];
  let start = 0;

  while (start < bytes.length) {
    let end = Math.min(start + params.maxBytes, bytes.length);

    // Not inside a character: back up from a byte that continues one to the byte that starts it.
    while (end < bytes.length && continues(bytes[end])) end -= 1;

    pieces.push(bytes.subarray(start, end).toString('utf8'));
    start = end;
  }

  return pieces;
}

/** What is left of `text` after its first `skip` bytes; `skip` is a character boundary of it. */
export function textFromByte(params: { text: string; skip: number }): string {
  return Buffer.from(params.text, 'utf8').subarray(params.skip).toString('utf8');
}

/**
 * The `closed` entry of a channel with output, at `end` bytes or its own cursor if that is more:
 * a node that was lost has no size of its own, but the output it printed before is there to read,
 * and a channel's offset never goes back.
 */
export function closedAt(params: { entry: ChannelEntry; end: number }): ChannelEntry {
  const { entry, end } = params;

  return { ...entry, cursor: outputCursor(Math.max(cursorNumber(entry.cursor), end)) };
}

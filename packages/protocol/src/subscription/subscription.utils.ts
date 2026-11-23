import type { CursorKind } from '../channel/channel.types.js';
import { MAX_TAIL, MAX_TAIL_BYTES, TAIL_PREFIX } from './subscription.constants.js';

/** The `n` of a `tail:<n>` position, or undefined for a position that is not a tail. */
export function tailCount(from: string): number | undefined {
  return from.startsWith(TAIL_PREFIX) ? Number(from.slice(TAIL_PREFIX.length)) : undefined;
}

/** The most a `tail` may ask for on a channel whose cursor counts `kind`. */
export function tailLimit(kind: CursorKind): number {
  return kind === 'sequence' ? MAX_TAIL : MAX_TAIL_BYTES;
}

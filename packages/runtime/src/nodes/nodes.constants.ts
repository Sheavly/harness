/**
 * The most entries one channel log keeps in memory: the newest. A reader that asks for an older
 * position is told it is gone (`cursor_out_of_range`) and starts from a snapshot of the tree.
 */
export const MAX_CHANNEL_ENTRIES = 1_000;

/**
 * What a node's title or status text may not hold, so it is valid on the wire: control characters
 * (newline and tab included), format characters, the line and paragraph separators, and lone
 * surrogates and private-use characters. The protocol's `SINGLE_LINE_PATTERN` refuses the same
 * class; a test holds the two together.
 */
export const NOT_ONE_LINE = /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}\p{Cs}\p{Co}]+/gu;

/**
 * How many times the cap of a title or status is read before it is made one line: enough for the
 * text to still fill the cap once control characters and runs of space are squeezed out of it, and
 * little enough that a huge input costs no more than a long one.
 */
export const HEAD_FACTOR = 8;

/** The title of a node whose own title is blank once it is one line. */
export const UNTITLED = 'untitled';

/**
 * The most entries one channel log keeps in memory: the newest. A reader that asks for an older
 * position is told it is gone (`cursor_out_of_range`) and starts from a snapshot of the tree.
 */
export const MAX_CHANNEL_ENTRIES = 1_000;

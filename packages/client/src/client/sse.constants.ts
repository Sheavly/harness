/**
 * How many small pieces of the frame being read are kept as they came before they are joined into
 * one. Without it a server that sends a frame one character at a time makes the client hold a
 * string and an array slot for each character, many times the frame's size; joined a thousand at a
 * time, a piece is at least a thousand characters and the cost of joining stays in proportion to
 * the frame.
 */
export const MAX_RECENT_PIECES = 1_024;

/**
 * The most characters one frame of a subscribe stream may hold before the client stops reading and
 * refuses it. The largest frame a server sends is the tree's snapshot, which at its bounds (1,000
 * nodes and as many approvals) is about 32 MiB of JSON, so this leaves room for it and no more: a
 * server that never ends a frame must not grow the client's memory without limit. Counted in
 * characters of the decoded text, which is what the client holds.
 */
export const MAX_SUBSCRIBE_FRAME_CHARS = 64 * 1024 * 1024;

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
 * How many times the cap of a title or status is read before it is made one line, so a huge input
 * costs no more than a long one. Text made mostly of control characters and runs of space still
 * fills the cap, but one that opens with more than `max * HEAD_FACTOR` of them (1,600 for a
 * title) reads as blank: that is the price of the bound, and a title or status like that is not
 * one a person wrote.
 */
export const HEAD_FACTOR = 8;

/** The title of a node whose own title is blank once it is one line. */
export const UNTITLED = 'untitled';

/**
 * The most an entry of the tree channel carries, as JSON: a quarter of what a store keeps
 * (`MAX_CHANNEL_ENTRY_CHARS`). The tree is what a sidebar needs, not each node's whole story (a
 * node's own channel and the conversation's stream have that), and a snapshot holds every node and
 * waiting approval at once: at its bounds (1,000 of each) it is about 32 MiB of JSON, not the 128 MiB
 * and more that full-size entries would make, which the server holds in memory and sends whole. A
 * command, an output or a message that does not fit is cut, and a cut approval says so.
 */
export const MAX_TREE_ENTRY_CHARS = 16_384;

/**
 * What an approval request whose command was cut to fit the tree channel may still offer there: to
 * skip it, never to run it or grant it from a text the client was not shown whole.
 */
export const CUT_APPROVAL_OPTIONS = ['skip', 'skip_with_message'] as const;

/** The longest tool name an approval request keeps when it is cut to fit the tree channel. */
export const MAX_CUT_TOOL_CHARS = 200;

/**
 * How long a cancel by node waits for the node to exit before it answers anyway: the kill was sent,
 * and the node's channel says when it ended. A process that cannot be killed (one that has left its
 * process group and holds its output open) never ends the task, and a cancel must not hold a
 * connection for ever.
 */
export const NODE_CANCEL_WAIT_MS = 10_000;

/** The largest byte offset a cursor may hold: fifteen digits, so it reads back exactly. */
export const MAX_BYTE_OFFSET = 999_999_999_999_999;

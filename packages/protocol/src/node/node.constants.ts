/**
 * The name of the conversation's tree channel. A node's channel is named by its id, so no node
 * may have this one.
 */
export const TREE_CHANNEL_NAME = 'tree';

/**
 * A node's id: lowercase letters, digits, hyphens and underscores, so it is safe in a message and
 * cannot collide with another by case on a case-insensitive disk, or look like `Tree`.
 */
export const NODE_ID_PATTERN = /^[a-z0-9][a-z0-9_-]*$/;

/** The longest a node id may be, in characters. */
export const MAX_NODE_ID_CHARS = 128;

/**
 * One line of plain text: none of the characters the terminal escapes (control characters, which
 * include newline and tab, format characters such as a zero-width joiner, and the line and
 * paragraph separators), and no lone surrogate or private-use character, which are not text. A
 * title with a newline would draw as several lines and could pass for a prompt of its own. The
 * terminal's own class is `\p{Cc}\p{Cf}\p{Zl}\p{Zp}`; this refuses that and a little more. It does
 * not make a title trustworthy: look-alike letters, a run of combining marks and a title that is
 * only like another's are accepted, so a front end never takes a title for an identity.
 */
export const SINGLE_LINE_PATTERN = /^[^\p{Cc}\p{Cf}\p{Zl}\p{Zp}\p{Cs}\p{Co}]+$/u;

/**
 * Text that shows as nothing: spaces of every kind, and the Hangul fillers and the Braille blank,
 * which draw as empty. A title or a status text of only these is blank.
 */
export const BLANK_PATTERN = /^[\s\u115F\u3164\uFFA0\u2800]*$/u;

/** The longest a node's title may be, in characters. */
export const MAX_NODE_TITLE_CHARS = 200;

/** The longest a node's status text may be, in characters. */
export const MAX_NODE_STATUS_CHARS = 200;

/**
 * The longest a command node's `command` may be. It is a bound for the wire, not a limit the
 * system puts on a command (a script's steps run as separate processes, so the line as a whole has
 * none, and `run_command` takes any length): whoever builds the node's body for the wire shortens
 * a longer line, as for `reason` and `error`. The node registry holds only a node's title and
 * status, and shortens those.
 */
export const MAX_NODE_COMMAND_CHARS = 131_072;

/** The longest a tool call's id may be: a provider's own, far below this. */
export const MAX_NODE_CALL_ID_CHARS = 200;

/** The longest a command node's `description` may be: the model's note on what it runs. */
export const MAX_NODE_DESCRIPTION_CHARS = 2_000;

/** The longest the `await_tasks` reason a node carries may be: the notice's own bound. */
export const MAX_NODE_REASON_CHARS = 1_000;

/**
 * The most of a command's output a node carries, the most recent part: the runtime keeps this many
 * characters of it (`MAX_TASK_OUTPUT_CHARS`, pinned equal by a test there), and the complete
 * output is its channel's.
 */
export const MAX_NODE_OUTPUT_CHARS = 30_000;

/** The longest an error text a node, a closed entry or the tree channel carries may be. */
export const MAX_NODE_ERROR_CHARS = 2_000;

/**
 * The most nodes one snapshot of the tree holds, ended ones included. The node registry refuses a
 * node past it, so a snapshot never has to be refused instead.
 */
export const MAX_TREE_NODES = 1_000;

/**
 * Names an extension may not take: the built-in node kinds and the tree channel, so an extension's
 * kind or event can never read as one of ours.
 */
export const RESERVED_EXTENSION_NAMES = ['agent', 'command', 'service', 'tree'] as const;

/** What a node is refused with when its state, end time and last outcome disagree. */
export const INCONSISTENT_NODE_MESSAGE =
  'A node is not its own parent; an open node has no endedAt and only an agent is idle; an ended one has an endedAt, and an ended agent has the last outcome its state comes from';

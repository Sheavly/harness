/** How long a backend the terminal started may take to say it listens. */
export const BACKEND_READY_MS = 30_000;

/** How long a backend may take to exit after SIGTERM before its process group is killed. */
export const BACKEND_STOP_MS = 10_000;

/** How often a stop checks whether the members of a backend's group are gone after its leader. */
export const GROUP_POLL_MS = 25;

/** How long a stop waits, after SIGKILL, for the killed group to be reaped before it gives up. */
export const GROUP_REAP_MS = 2000;

/**
 * The line a backend prints once it listens: `→ listening on <url>`. Only a whole line counts,
 * its newline included: output read in chunks can end in the middle of the address, and the
 * terminal sends its token to whatever address it takes from here.
 */
export const LISTENING_LINE = /(?<![^\r\n])→ listening on (\S+)(?=[\r\n])/;

/** How long a backend that is already running may take to answer `--trust` before the start fails. */
export const TRUST_TIMEOUT_MS = 10_000;

/** The most characters of a backend's refusal the terminal prints: a refusal is shown, not read out. */
export const TRUST_REASON_MAX_CHARS = 200;

/** What replaces the backend token in text a backend sent back. */
export const TOKEN_REDACTED = '[token hidden]';

/** What replaces a backend's whole refusal text when it echoes part of the token. */
export const TEXT_HIDDEN = "[the backend's text was hidden: it echoed the token]";

/** How many consecutive characters of the token make an echo: fewer are too common to mean it. */
export const TOKEN_ECHO_CHARS = 8;

/** The workspace whose `serve` script the terminal runs to start a backend. */
export const BACKEND_PACKAGE = '@sheavly/backend';

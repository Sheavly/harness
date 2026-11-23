/** A comment line sent while a stream is quiet, so a proxy in between never closes it as idle. */
export const HEARTBEAT_MS = 15_000;

/**
 * How many entries a stream may have waiting for a slow consumer. Past it the stream is cut and
 * the client resumes with `Last-Event-ID`, so the server's memory per stream stays bounded.
 */
export const SSE_QUEUE_LIMIT = 1000;

/** The largest request body the server reads: a prompt or saved history, never a file upload. */
export const MAX_BODY_BYTES = 5_000_000;

/**
 * The largest body a public route reads. Those routes answer before the bearer check, so they
 * must not let anyone make the server buffer megabytes unauthenticated; a nonce is under 100 bytes.
 */
export const PUBLIC_MAX_BODY_BYTES = 1024;

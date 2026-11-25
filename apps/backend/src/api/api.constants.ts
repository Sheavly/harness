/** A comment line sent while a stream is quiet, so a proxy in between never closes it as idle. */
export const HEARTBEAT_MS = 15_000;

/**
 * How many entries a stream may have waiting for a slow consumer. Past it the stream is cut and
 * the client resumes with `Last-Event-ID`, so the server's memory per stream stays bounded.
 */
export const SSE_QUEUE_LIMIT = 1000;

/** The host names a request may always use: this machine, however a client spells it. */
export const LOOPBACK_HOST_NAMES: readonly string[] = ['localhost', '127.0.0.1', '[::1]'];

/**
 * A host name or an IP literal on its own: `myhost.example`, `127.0.0.1`, `[::1]`. Every label
 * holds a letter or a digit (no `.`, `..` or `-` alone), and one trailing dot is allowed.
 */
export const HOST_NAME =
  /^(?:\[[0-9a-f:.]+\]|[a-z0-9_](?:[a-z0-9_-]*[a-z0-9_])?(?:\.[a-z0-9_](?:[a-z0-9_-]*[a-z0-9_])?)*\.?)$/i;

/** A `Host` header's value: a host name, then a port when there is one. Anything else is no host. */
export const HOST_HEADER =
  /^(\[[0-9a-f:.]+\]|[a-z0-9_](?:[a-z0-9_-]*[a-z0-9_])?(?:\.[a-z0-9_](?:[a-z0-9_-]*[a-z0-9_])?)*\.?)(?::\d{1,5})?$/i;

/** Why a request is refused before anything else looks at it. Fixed text: it never echoes the request. */
export const REFUSED_HOST_MESSAGE = 'This server does not answer requests for that host name';
export const REFUSED_ORIGIN_MESSAGE = 'This server does not answer requests from a web page';

/** The largest request body the server reads: a prompt or saved history, never a file upload. */
export const MAX_BODY_BYTES = 5_000_000;

/**
 * The largest body a public route reads. Those routes answer before the bearer check, so they
 * must not let anyone make the server buffer megabytes unauthenticated; a nonce is under 100 bytes.
 */
export const PUBLIC_MAX_BODY_BYTES = 1024;

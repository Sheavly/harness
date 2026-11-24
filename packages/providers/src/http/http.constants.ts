/**
 * The metadata keys an adapter's config schema carries so the registry can tell a form from a
 * secret from what the host supplies. A field with neither is something a person chooses, and a
 * model's file holds it.
 */
export const FIELD_KIND = { secret: 'secret', host: 'host' } as const;

/** Milliseconds in a second: `retry-after` is sent in seconds. */
export const MS_PER_SECOND = 1000;

/**
 * The longest `retry-after` worth waiting for. A server asking for more (a day, say) gets its
 * error reported instead, rather than a run that hangs with nothing to show for it.
 */
export const MAX_RETRY_AFTER_MS = 60_000;

/** Milliseconds in a minute: an outage is reported in minutes once it is a minute long. */
export const MS_PER_MINUTE = 60_000;

/** How long one connectivity probe waits for any answer before it counts as failed. */
export const PROBE_TIMEOUT_MS = 5000;

/** The longest wait between two attempts while offline: a connection that is back is noticed within it. */
export const OFFLINE_MAX_DELAY_MS = 30_000;

/**
 * The shortest wait between two attempts while offline, whatever `retryDelayMs` is (0 is allowed):
 * a call that sends and probes again at once would spin for the whole budget.
 */
export const OFFLINE_MIN_DELAY_MS = 1000;

/** Doublings of the retry delay while offline stop here, so `2 ** round` never grows without bound. */
export const OFFLINE_MAX_BACKOFF_ROUNDS = 8;

/**
 * How long a started reply may send nothing before its connection is taken for lost. Long, because
 * a model may think a while without streaming a byte, and only a connection that died without
 * saying so (a sleep, a dead route) is stopped by it.
 */
export const STREAM_IDLE_MS = 300_000;

/** A wait while offline is cut into slices this long, so a machine that slept is noticed at its first. */
export const WAKE_CHECK_MS = 1000;

/**
 * A step that took this much longer than it was meant to is taken for the machine having slept:
 * timers stop while it does, and the wall clock does not.
 */
export const WAKE_GAP_MS = 5000;

/**
 * A host on this machine or its own network, which losing the internet does not cut off: a name
 * with no dot (`localhost`, `ollama`), `.local` and `.internal` names, `::1` and the private
 * ranges of IPv6 (`fc00::/7`, `fe80::/10`, as a URL writes them, in brackets), and the loopback,
 * private and link-local ranges of IPv4.
 */
export const LOCAL_HOST =
  /^(?:[^.:[\]]+|.+\.(?:local|internal)|\[?::1\]?|\[(?:f[cd][0-9a-f]{2}|fe[89ab][0-9a-f]):.*\]|127(?:\.\d{1,3}){3}|10(?:\.\d{1,3}){3}|192\.168(?:\.\d{1,3}){2}|172\.(?:1[6-9]|2\d|3[01])(?:\.\d{1,3}){2}|169\.254(?:\.\d{1,3}){2})$/i;

/** Query parameter names that carry a credential, so an endpoint URL is stored without them. */
export const SECRET_QUERY_NAME =
  /(?:^|[-_])(?:api[-_]?key|key|token|secret|sig|signature|auth|authorization|password|credential)s?(?:$|[-_])/i;

/** What a credential query value is replaced with in a stored endpoint. */
export const REDACTED_QUERY_VALUE = 'REDACTED';

/** Where a server-sent events line ends: `\r\n`, `\r` or `\n`. */
export const LINE_BREAK = /\r\n|\r|\n/;

/**
 * The TLS key exchange groups a model call offers, in OpenSSL's list syntax. X25519 comes first
 * because only the first group gets a key share: OpenSSL 3.5's default (Node 22.20+, 24.5+, 26)
 * also sends a 1,216-byte ML-KEM share, which pushes the ClientHello past one TCP segment, and
 * gateways that read only the first segment (Azure AI Foundry) reset the connection.
 * ML-KEM stays listed, so a server that prefers it still gets it after a HelloRetryRequest.
 */
export const MODEL_TLS_GROUPS = 'X25519:X25519MLKEM768:P-256:P-384:P-521';

/** The code Node gives a TLS context whose group list names a group this OpenSSL doesn't know. */
export const UNKNOWN_TLS_GROUP_CODE = 'ERR_CRYPTO_OPERATION_FAILED';

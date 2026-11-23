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

/**
 * Errors from the model backends. Providers don't depend on `@sheavly/runtime`, so they keep their own;
 * each has a `reason` a caller can switch on, and keeps the original as `cause`.
 */

/** An adapter can't be registered or built: a duplicate kind, an unknown kind, a bad config. */
export class AdapterError extends Error {
  override name = 'AdapterError';
  readonly reason: 'duplicate' | 'unknown' | 'invalid_config';
  /** The adapter kind asked for (`openai`, `azure-openai`, ...). */
  readonly kind: string;

  constructor(params: {
    reason: 'duplicate' | 'unknown' | 'invalid_config';
    kind: string;
    message: string;
    cause?: unknown;
  }) {
    const { reason, kind, message, cause } = params;

    super(message, cause === undefined ? undefined : { cause });
    this.reason = reason;
    this.kind = kind;
  }
}

/** Why a model API call failed. */
type ModelApiFailure =
  'http' | 'network' | 'timeout' | 'failed' | 'stream_error' | 'cut_off' | 'bad_payload';

/**
 * A model API call failed (any protocol: Responses, Anthropic Messages): an HTTP error (`status`),
 * the request not reaching the server (`network`) or no response in time (`timeout`), a failure
 * or error event in the stream, a stream that ended before its final event (`cut_off`), or a
 * payload that isn't JSON. The message names the API.
 */
export class ModelApiError extends Error {
  override name = 'ModelApiError';
  readonly reason: ModelApiFailure;
  /** The HTTP status, for `http`. */
  readonly status: number | undefined;

  constructor(params: {
    reason: ModelApiFailure;
    message: string;
    status?: number;
    cause?: unknown;
  }) {
    const { reason, message, status, cause } = params;

    super(message, cause === undefined ? undefined : { cause });
    this.reason = reason;
    this.status = status;
  }
}

/**
 * A request cannot be signed: a signature covers plain headers and a string body, and the protocol
 * built something else. A bug in the protocol, not a failure of the call, so it is never retried.
 */
export class RequestSigningError extends Error {
  override name = 'RequestSigningError';

  constructor(params: { message: string }) {
    super(params.message);
  }
}

/**
 * The model fetch was given what undici's own `fetch` can't take: a global `Request` as its input,
 * or a global `FormData` as its body. A bug in the caller, not a failure of the call: `sendRequest`
 * passes it through as it came and never retries it. Pass a URL and a string body, as it does.
 */
export class ModelFetchError extends Error {
  override name = 'ModelFetchError';
  readonly reason: 'request_input' | 'form_data_body';

  constructor(params: { reason: 'request_input' | 'form_data_body'; message: string }) {
    const { reason, message } = params;

    super(message);
    this.reason = reason;
  }
}

/** The provider switch can't serve: an unknown provider name, or none active yet. */
export class ProviderSwitchError extends Error {
  override name = 'ProviderSwitchError';
  readonly reason: 'unknown' | 'none_active';

  constructor(params: { reason: 'unknown' | 'none_active'; message: string }) {
    const { reason, message } = params;

    super(message);
    this.reason = reason;
  }
}

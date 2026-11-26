import type { ServerErrorCode } from '@sheavly/protocol/server/server.types';

/**
 * A backend refused a client's request: `code` is the protocol's reason (`not_found`,
 * `unknown_model`, …) when its body said one, for a UI to branch on; `status` the HTTP status.
 */
export class RefusedError extends Error {
  override name = 'RefusedError';
  readonly status: number;
  readonly code: ServerErrorCode | undefined;

  constructor(params: { status: number; code?: ServerErrorCode | undefined; message: string }) {
    const { status, code, message } = params;

    super(message);
    this.status = status;
    this.code = code;
  }
}

/**
 * A prompt waited in the conversation's queue and could not start when its turn came (its skill
 * is gone, the conversation can no longer be stored): the backend's reason is the message.
 */
export class PromptRefusedError extends Error {
  override name = 'PromptRefusedError';

  constructor(params: { message: string }) {
    super(params.message);
  }
}

/** A stream that should never end ended: the backend or a proxy cut it. The cause of a reconnect. */
export class StreamEndedError extends Error {
  override name = 'StreamEndedError';
  readonly lastEventId: number | undefined;

  constructor(params: { lastEventId: number | undefined }) {
    super('The stream ended, and it should not end');
    this.lastEventId = params.lastEventId;
  }
}

/**
 * A stream dropped and the client gave up reconnecting: `lastEventId` is the last entry it got
 * (none when it never got one), so a UI can show the gap or resume later with that id, and
 * `attempts` how many times it tried in a row. The reason it stopped is the `cause`.
 */
export class StreamLostError extends Error {
  override name = 'StreamLostError';
  readonly lastEventId: number | undefined;
  readonly attempts: number;

  constructor(params: { lastEventId: number | undefined; attempts: number; cause: unknown }) {
    const { lastEventId, attempts, cause } = params;

    const why = cause instanceof Error ? cause.message : String(cause);

    super(`Lost the stream after ${String(attempts)} reconnect attempts: ${why}`, { cause });
    this.lastEventId = lastEventId;
    this.attempts = attempts;
  }
}

/**
 * A channel ended `failed`: no more of its entries will come, because storing it failed, no writer
 * has it, or its conversation closed (a reopened conversation goes on from it). What was read is not
 * all of it, so a reader that took the end for a complete channel would be wrong; this tells it.
 */
export class ChannelFailedError extends Error {
  override name = 'ChannelFailedError';
  readonly channel: string;

  constructor(params: { channel: string }) {
    super(
      `The channel ${params.channel} ended without its last entries: storing it failed, or its conversation closed`,
    );
    this.channel = params.channel;
  }
}

/**
 * A public route's answer was larger than the client reads (`PUBLIC_ANSWER_MAX_BYTES`): it stopped
 * reading and cancelled the body. Whatever answered is not the server, which answers a few bytes.
 */
export class AnswerTooLargeError extends Error {
  override name = 'AnswerTooLargeError';

  constructor(params: { route: string; maxBytes: number }) {
    const { route, maxBytes } = params;

    super(`The answer to ${route} is larger than ${String(maxBytes)} bytes`);
  }
}

/** A public route's request was answered with a redirect, which the client never follows. */
export class RedirectedError extends Error {
  override name = 'RedirectedError';

  constructor(params: { route: string }) {
    super(`The answer to ${params.route} is a redirect, which a public route never follows`);
  }
}

/** `verifyServer` got an empty token: nothing can be verified against it, and no request is made. */
export class EmptyTokenError extends Error {
  override name = 'EmptyTokenError';

  constructor() {
    super('verifyServer needs a non-empty token');
  }
}

/**
 * The server did not answer `verifyServer` within `timeoutMs`. It is a failure to reach a server,
 * like a refused connection, not a verdict about one: the caller decides what an absent server
 * means. The abort the timer caused is the `cause`.
 */
export class VerifyTimeoutError extends Error {
  override name = 'VerifyTimeoutError';
  readonly timeoutMs: number;

  constructor(params: { timeoutMs: number; cause: unknown }) {
    const { timeoutMs, cause } = params;

    super(`The server did not answer within ${String(timeoutMs)} ms`, { cause });
    this.timeoutMs = timeoutMs;
  }
}

/**
 * A backend's answer didn't match the contract: the route's schema refused it. A client and
 * backend that drifted apart fail here, loudly, instead of passing on data no type describes.
 */
export class AnswerError extends Error {
  override name = 'AnswerError';

  constructor(params: { route: string; cause: unknown }) {
    const { route, cause } = params;

    super(`The backend's answer to ${route} doesn't match the contract`, { cause });
  }
}

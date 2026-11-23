/** A mistake in what the user typed: it ends with its message and exit code 2, never a stack. */
export class UsageError extends Error {
  override name = 'UsageError';
}

/**
 * No running server can be used: none was found, or the one found speaks a protocol this command
 * can't. The message says why and what to do, over several lines, and never holds the token.
 */
export class NoServerError extends Error {
  override name = 'NoServerError';
}

/**
 * No server is running for this home at all (as against one the command can't use, a protocol
 * mismatch). The only case in which `sheavly setup` may start a short-lived server of its own.
 */
export class ServerNotRunningError extends NoServerError {
  override name = 'ServerNotRunningError';
}

/**
 * `sheavly connection` was given an environment it cannot use: `BACKEND_URL` that is not a web
 * URL, or without `BACKEND_TOKEN`. One line naming the variable; it never holds a value, since
 * one of them is the token.
 */
export class ConnectionError extends Error {
  override name = 'ConnectionError';
}

/**
 * `sheavly doctor` found something wrong. The report is already printed; this is the one line
 * after it and the reason the command exits 1.
 */
export class DoctorFailedError extends Error {
  override name = 'DoctorFailedError';
}

/**
 * `sheavly service` refused or could not do what it was asked: where it is not supported, what is
 * missing, or a systemd command that failed. One line saying why and what to do; it never holds
 * the token.
 */
export class ServiceError extends Error {
  override name = 'ServiceError';
}

/** The command line's own `package.json` could not be read or has no version. */
export class VersionError extends Error {
  override name = 'VersionError';
  readonly file: string;

  constructor(params: { message: string; file: string; cause?: unknown }) {
    super(params.message, { cause: params.cause });
    this.file = params.file;
  }
}

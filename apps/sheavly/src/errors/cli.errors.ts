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

/** The command line's own `package.json` could not be read or has no version. */
export class VersionError extends Error {
  override name = 'VersionError';
  readonly file: string;

  constructor(params: { message: string; file: string; cause?: unknown }) {
    super(params.message, { cause: params.cause });
    this.file = params.file;
  }
}

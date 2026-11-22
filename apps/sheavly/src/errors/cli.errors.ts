/** A mistake in what the user typed: it ends with its message and exit code 2, never a stack. */
export class UsageError extends Error {
  override name = 'UsageError';
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

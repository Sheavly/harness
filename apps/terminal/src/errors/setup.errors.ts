/** Setup stopped before a conversation could be opened. */
export class SetupError extends Error {
  override name = 'SetupError';
}

/** Escape or Ctrl+C in the setup UI. */
export class SetupCancelledError extends SetupError {
  override name = 'SetupCancelledError';

  constructor() {
    super('Setup cancelled. Run `sheavly setup` to continue.');
  }
}

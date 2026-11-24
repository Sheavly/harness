/** Why a store refused or failed an operation. */
type StoreFailure =
  /** `append` got an entry whose `seq` isn't the next one: something was lost or repeated. */
  | 'out_of_order'
  /**
   * An entry given to a channel is not one the store can keep and read back: not the shape of a
   * channel's entry, or longer than `MAX_CHANNEL_ENTRY_CHARS`. Nothing was stored; the caller's
   * to fix, and no retry changes it.
   */
  | 'invalid'
  /** A channel's `read` started after a cursor the channel does not hold: ask again from `start`. */
  | 'cursor_out_of_range'
  /** A channel or its conversation is past a limit: the entry was not stored, and none will be. */
  | 'quota'
  /** Storage itself failed (disk full, permissions, unreadable data); see `cause`. */
  | 'failed';

/**
 * A conversation store refused or failed an operation. A UI or host stops the conversation on
 * `failed` rather than carry on unrecorded; `cause` is the storage error behind it.
 */
export class StoreError extends Error {
  override name = 'StoreError';
  readonly reason: StoreFailure;

  constructor(params: { reason: StoreFailure; message: string; cause?: unknown }) {
    const { reason, message, cause } = params;

    super(message, { cause });
    this.reason = reason;
  }
}

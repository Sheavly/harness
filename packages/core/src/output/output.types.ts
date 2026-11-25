import type { OutputLog, OutputRef, OutputStatus } from '@sheavly/protocol/output/output.types';

/** Random access to a log's stored bytes; the store provides it, so reading never holds a whole log. */
export type ByteSource = {
  /** Bytes stored right now. */
  size(): Promise<number>;
  /** Up to `length` bytes from `offset`; fewer only at the end. */
  read(params: { offset: number; length: number }): Promise<Buffer>;
};

/** A chunk of a capture once it is stored: the byte offset of its first byte, and its text. */
export type StoredChunk = { offset: number; text: string };

/** One capture in progress: what a command's output is appended to as it arrives. */
export type OutputWriter = {
  /** What is stored so far; `capturing` until `close`. */
  readonly log: OutputLog;
  /**
   * Calls `listener` with each chunk from now on, once it is stored and so readable from the store:
   * in order, each starting where the one before it ended, and never one that was dropped for a
   * limit or a failed write. A reader that registers and then reads what is stored reads every byte
   * there is, once (the chunks it hears below the offset it read are the ones it has). A listener
   * that throws does not stop the capture. Returns the stop.
   */
  follow(listener: (chunk: StoredChunk) => void): () => void;
  /**
   * Stores `chunk` after everything before it. Never throws and never blocks the command: a
   * failure or a limit is recorded as `incomplete` with its reason and later chunks are dropped.
   */
  append(chunk: string): void;
  /** Waits for what was appended to be stored and ends the capture. Safe to call twice. */
  close(): Promise<OutputLog>;
};

/** A slice of a stored log. `nextOffset` is where to continue, absent at the end of what is stored. */
export type OutputRange = {
  ref: OutputRef;
  text: string;
  /** Byte offset of `text`'s first character (moved forward past a split character). */
  offset: number;
  nextOffset?: number | undefined;
  totalBytes: number;
  status: OutputStatus;
  reason?: string | undefined;
};

/** A literal match: the byte offset where it starts and the text around it. */
export type OutputMatch = { offset: number; snippet: string };

/** What `OutputStore.search` takes. */
export type OutputSearchParams = {
  ref: OutputRef;
  query: string;
  fromOffset: number;
  maxMatches: number;
};

/** Matches found from `fromOffset`; `nextOffset` continues the search when it stopped early. */
export type OutputSearch = {
  ref: OutputRef;
  matches: OutputMatch[];
  nextOffset?: number | undefined;
  totalBytes: number;
  status: OutputStatus;
  reason?: string | undefined;
};

/**
 * The read side of the store: what the `output:read` grant allows. Every method rejects with an
 * `OutputError`, and a reference from another conversation is `not_found`.
 */
export type OutputReader = {
  /** What is known about a log. */
  log(ref: OutputRef): Promise<OutputLog>;
  /** Up to `maxBytes` from byte `offset`, never ending inside a character. */
  read(params: { ref: OutputRef; offset: number; maxBytes: number }): Promise<OutputRange>;
  /** Literal, case-sensitive matches from byte `fromOffset`. */
  search(params: OutputSearchParams): Promise<OutputSearch>;
};

/**
 * The write side of the store: what the `output:capture` grant allows. A new capture fills the
 * store's quota, so it is a separate capability from reading.
 */
export type OutputCapture = {
  /** Starts a capture. Rejects (`unavailable`) when storage cannot take one. */
  create(): Promise<OutputWriter>;
};

/**
 * One conversation's complete command output. Its logs are private to that conversation: a
 * reference from another conversation is `not_found`, whatever it names. Every method rejects with
 * an `OutputError`. The app holds the whole store; an extension gets `OutputReader` and
 * `OutputCapture` separately.
 */
export type OutputStore = OutputReader & OutputCapture;

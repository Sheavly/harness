import { ZodError } from 'zod';
import type { StreamEntry } from '@sheavly/protocol/stream/stream.types';
import {
  AnswerError,
  RefusedError,
  StreamEndedError,
  StreamLostError,
} from '../errors/client.errors.js';
import type { ReconnectPolicy } from './client.types.js';
import { readFrames } from './entries.helper.js';
import {
  RECONNECT_BUDGET_MS,
  RECONNECT_INITIAL_MS,
  RECONNECT_MAX_MS,
  RECONNECT_STABLE_MS,
} from './reconnect.constants.js';

/** Waits `ms`, or until `signal` aborts (it then resolves early; the caller checks the signal). */
function waitFor(params: { ms: number; signal: AbortSignal }): Promise<void> {
  const { ms, signal } = params;

  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);

    signal.addEventListener(
      'abort',
      () => {
        clearTimeout(timer);
        resolve();
      },
      { once: true },
    );
  });
}

/**
 * Whether reconnecting can help: a dropped connection or a server that failed, yes; a refusal
 * (the request itself is wrong) or an entry the contract does not allow, no, since asking again
 * gets the same answer.
 */
function canReconnectAfter(error: unknown): boolean {
  if (error instanceof RefusedError) return error.status >= 500;

  return !(error instanceof AnswerError || error instanceof ZodError);
}

/**
 * A stream's entries that survives a dropped connection. `open` opens the stream, resuming after
 * `lastEventId` when it has one (the backend replays from there); each entry is yielded once, in
 * order, because an entry at or before the last one seen is skipped. After a drop it waits, doubling
 * from `RECONNECT_INITIAL_MS` up to `RECONNECT_MAX_MS`, and tries again; an entry arriving, or a
 * connection that stayed up `RECONNECT_STABLE_MS`, resets the count. Ends when the stream ends cleanly or `signal` aborts, unless the stream is `endless`.
 * Throws `StreamLostError` once the attempts in a row (without an entry) have failed for
 * `budgetMs` (`RECONNECT_BUDGET_MS`, an hour, unless given), or `attempts` in a row when it is
 * given, and any error reconnecting cannot help (a refusal) as it is. The budget is read from
 * `performance.now()`, which on Linux and macOS stops while the machine sleeps: a stream
 * followed across a sleep is picked up again on waking, and the sleep is not spent.
 */
export async function* reconnectingEntries(
  params: {
    open: (resume: {
      lastEventId: number | undefined;
    }) => Promise<ReadableStream<Uint8Array> | null>;
    signal: AbortSignal;
    /**
     * The stream has no end of its own (a conversation's whole stream, which only the client
     * leaves), so one that ends is one the backend cut, such as a slow consumer: it is a drop.
     */
    endless?: boolean;
  } & ReconnectPolicy,
): AsyncGenerator<StreamEntry> {
  const { open, signal, endless = false, attempts, wait = waitFor } = params;
  const budgetMs = params.budgetMs ?? RECONNECT_BUDGET_MS;
  const progress: Progress = { lastEventId: undefined, failures: 0, failingSince: undefined };

  while (!signal.aborted) {
    // Set once the stream is open: time spent waiting for an answer is not a connection staying up.
    let openedAt: number | undefined;

    try {
      const body = await open({ lastEventId: progress.lastEventId });

      openedAt = performance.now();
      yield* newEntries({ body, progress });

      if (!endless) return;

      throw new StreamEndedError({ lastEventId: progress.lastEventId });
    } catch (caughtError) {
      if (signal.aborted) return;

      // A connection that stayed up was healthy even if no entry came: it starts the count again.
      if (openedAt !== undefined && performance.now() - openedAt >= RECONNECT_STABLE_MS) {
        stopFailing(progress);
      }

      const ms = backoffAfter({ error: caughtError, progress, attempts, budgetMs });

      await wait({ ms, signal });
    }
  }
}

/**
 * What a stream has delivered so far, how many attempts in a row have failed since, and when (by
 * `performance.now()`) the first of them did.
 */
type Progress = {
  lastEventId: number | undefined;
  failures: number;
  failingSince: number | undefined;
};

/** The run of failed attempts is over: an entry arrived, or a connection stayed up. */
function stopFailing(progress: Progress): void {
  progress.failures = 0;
  progress.failingSince = undefined;
}

/** The entries of one connection that are new: each one moves `progress` on and ends a failing run. */
async function* newEntries(params: {
  body: ReadableStream<Uint8Array> | null;
  progress: Progress;
}): AsyncGenerator<StreamEntry> {
  const { body, progress } = params;

  for await (const { cursor, entry } of readFrames(body)) {
    if (!entry) {
      // The head frame of a live stream: with nothing received yet, a reconnect resumes after it.
      // Only a plain non-negative integer is a seq: an empty or odd id would skip real entries.
      const head = /^\d+$/.test(cursor) ? Number(cursor) : undefined;

      if (progress.lastEventId === undefined && head !== undefined && Number.isSafeInteger(head)) {
        progress.lastEventId = head;
      }

      continue;
    }

    if (progress.lastEventId !== undefined && entry.seq <= progress.lastEventId) continue;

    progress.lastEventId = entry.seq;
    stopFailing(progress);
    yield entry;
  }
}

/**
 * Counts a failed attempt and returns how long to wait before the next. Throws the error when
 * reconnecting cannot help, and `StreamLostError` when `attempts` (when given) in a row have
 * failed or they have failed for `budgetMs`.
 */
function backoffAfter(params: {
  error: unknown;
  progress: Progress;
  attempts: number | undefined;
  budgetMs: number;
}): number {
  const { error, progress, attempts, budgetMs } = params;

  if (!canReconnectAfter(error)) throw error;

  progress.failures += 1;
  progress.failingSince ??= performance.now();

  const failedFor = performance.now() - progress.failingSince;

  if ((attempts !== undefined && progress.failures > attempts) || failedFor >= budgetMs) {
    throw new StreamLostError({
      lastEventId: progress.lastEventId,
      attempts: progress.failures - 1,
      cause: error,
    });
  }

  return Math.min(RECONNECT_INITIAL_MS * 2 ** (progress.failures - 1), RECONNECT_MAX_MS);
}

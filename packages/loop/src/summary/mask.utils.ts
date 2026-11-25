import type { Message } from '@sheavly/protocol/message/message.types';
import { hiddenToolResult } from './mask.prompt.js';
import {
  MASK_KEEP_SHARE,
  MASK_MIN_CHARS,
  MASK_START_SHARE,
  MASK_STEP_RESULTS,
} from './summary.constants.js';
import { estimateTokens } from './summary.utils.js';

/** The line that says where a command's complete output is kept, if the result has one. */
function referenceLine(content: string): string | undefined {
  return /(?:^|[\r\n])(Full output: output_ref=[^\r\n]*)/.exec(content)?.[1];
}

/**
 * How many of the oldest tool results are hidden: those older than the newest ones that fit in
 * `MASK_KEEP_SHARE` of the window, rounded down to whole steps, so the count grows in jumps and
 * the prompt prefix a provider caches changes only every few results. The newest result is always
 * kept, however large.
 */
function hiddenCount(params: { view: readonly Message[]; window: number }): number {
  const { view, window } = params;
  const results = view.filter((message) => message.role === 'tool');
  let kept = 0;
  let tokens = 0;

  for (const result of results.toReversed()) {
    tokens += estimateTokens(result);

    if (kept > 0 && tokens > window * MASK_KEEP_SHARE) break;

    kept += 1;
  }

  // A step of eight suits many small results; with a few large ones it would never be reached.
  const step = Math.min(MASK_STEP_RESULTS, Math.max(1, Math.floor(kept / 2)));

  return Math.floor((results.length - kept) / step) * step;
}

/**
 * `view` with its oldest large tool results replaced by a note, for one model call (stored history
 * and what a summarizer reads are untouched). Applies only once the view is estimated to fill
 * `MASK_START_SHARE` of the window, and decides from the view itself, never from a reported
 * usage, so what is hidden only grows until a summary: it cannot flip back and break the cached
 * prompt prefix. Calls stay paired with their results, the error flag stays, and a result's
 * `output_ref` line is kept. Returns `view` itself when nothing is hidden. Without a known
 * window nothing is hidden.
 */
export function maskOldToolOutput(params: {
  view: readonly Message[];
  window: number | undefined;
}): readonly Message[] {
  const { view, window } = params;

  if (window === undefined) return view;

  const tokens = view.reduce((sum, message) => sum + estimateTokens(message), 0);

  if (tokens < window * MASK_START_SHARE) return view;

  const hidden = hiddenCount({ view, window });

  if (hidden === 0) return view;

  let seen = 0;

  return view.map((message) => {
    if (message.role !== 'tool') return message;

    const ordinal = seen;

    seen += 1;

    if (ordinal >= hidden || message.content.length < MASK_MIN_CHARS) return message;

    return {
      ...message,
      content: hiddenToolResult({
        chars: message.content.length,
        reference: referenceLine(message.content),
      }),
    };
  });
}

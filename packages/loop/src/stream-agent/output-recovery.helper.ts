import { ConnectionLostError } from '@sheavly/core/errors/connection.errors';
import type { DoneReason } from '@sheavly/protocol/event/event.types';
import {
  MAX_FRUITLESS_CONTINUATIONS,
  MAX_LOST_CONNECTIONS_IN_A_ROW,
} from './stream-agent.constants.js';
import type { TurnContext } from './stream-agent.types.js';

/**
 * A reply cut short by a lost connection is the same as one cut short by the output limit: what
 * arrived is valid, and the model is asked for the unfinished work only, with the same bounds
 * (`maxOutputContinuations`, `MAX_FRUITLESS_CONTINUATIONS`) and one of its own: no more than
 * `MAX_LOST_CONNECTIONS_IN_A_ROW` calls in a row, however much each kept. True when the run goes
 * on; false for any other error, or when a bound is reached, and the run fails with the error.
 * Counts the loss in `context.connectionLosses`.
 */
export function continueAfterLostConnection(params: {
  context: TurnContext;
  error: unknown;
  progressed: boolean;
}): boolean {
  const { context, error, progressed } = params;

  if (!(error instanceof ConnectionLostError)) return false;

  context.connectionLosses.inARow += 1;

  if (context.connectionLosses.inARow > MAX_LOST_CONNECTIONS_IN_A_ROW) return false;

  return continueAfterOutputLimit({ context, progressed }) === undefined;
}

/**
 * Preserve partial replies and completed tool results, then ask for the unfinished work only.
 * `progressed` is whether the truncated reply kept any text or tool call; consecutive replies that
 * kept none end the run, since asking again repeats the same cut-off.
 */
export function continueAfterOutputLimit(params: {
  context: TurnContext;
  progressed: boolean;
}): DoneReason | undefined {
  const { context, progressed } = params;
  const { options, turn, outputRecovery } = context;
  const maxAttempts = options.maxOutputContinuations;

  outputRecovery.fruitless = progressed ? 0 : outputRecovery.fruitless + 1;

  if (outputRecovery.fruitless >= MAX_FRUITLESS_CONTINUATIONS) return 'max_tokens';
  if (maxAttempts !== undefined && outputRecovery.attempts >= maxAttempts) return 'max_tokens';
  if (turn >= (options.maxTurns ?? Infinity)) return 'max_turns';

  outputRecovery.attempts++;
  outputRecovery.pending = {
    kind: 'output-continuation',
    attempt: outputRecovery.attempts,
    ...(maxAttempts !== undefined && { maxAttempts }),
  };

  return undefined;
}

import { ConnectionLostError } from '@sheavly/core/errors/connection.errors';
import type { DoneReason } from '@sheavly/protocol/event/event.types';
import {
  MAX_FRUITLESS_CONTINUATIONS,
  MAX_LOST_CONNECTIONS_IN_A_ROW,
} from './stream-agent.constants.js';
import type { TurnContext } from './stream-agent.types.js';

/**
 * A reply cut short by a lost connection leaves what arrived valid, as the output limit does, and
 * the model is asked for the unfinished work only, with a notice that says why. It has a count of
 * its own and spends none of the output limit's (`maxOutputContinuations` is for replies that
 * hit the limit): no more than `MAX_LOST_CONNECTIONS_IN_A_ROW` calls in a row, however much each
 * kept, and never past `maxTurns`. True when the run goes on; false for any other error, or when a
 * bound is reached, and the run fails with the error. Counts the loss in
 * `context.connectionLosses`.
 */
export function continueAfterLostConnection(params: {
  context: TurnContext;
  error: unknown;
}): boolean {
  const { context, error } = params;
  const { options, turn, connectionLosses, outputRecovery } = context;

  if (!(error instanceof ConnectionLostError)) return false;

  connectionLosses.inARow += 1;

  if (connectionLosses.inARow > MAX_LOST_CONNECTIONS_IN_A_ROW) return false;
  if (turn >= (options.maxTurns ?? Infinity)) return false;

  outputRecovery.pending = {
    kind: 'output-continuation',
    attempt: connectionLosses.inARow,
    reason: 'connection',
  };

  return true;
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

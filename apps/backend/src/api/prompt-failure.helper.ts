import { redactDiagnosticText } from '@sheavly/core/text/diagnostic-text.utils';
import { errorMessage } from '@sheavly/runtime/errors/errors.utils';

/**
 * Tells the operator, on stderr, that a prompt the conversation ran itself failed: clients see it
 * on the stream (`run_failed`), but nothing awaits the run to report it to.
 */
export function logPromptFailure(caughtError: unknown): void {
  process.stderr.write(`prompt failed: ${redactDiagnosticText(errorMessage(caughtError))}\n`);
}

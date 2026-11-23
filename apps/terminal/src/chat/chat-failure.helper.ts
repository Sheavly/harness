import { SetupCancelledError } from '../errors/setup.errors.js';
import { describeFailure } from '../render/terminal-text.utils.js';

/**
 * The message without the user name and password of any URL in it: fetch echoes a BACKEND_URL
 * that holds them, and a token pasted there must not reach the terminal. In each run of
 * non-space characters, everything from after `://` to its last `@` goes, so a password holding
 * `@`, `/`, `#` or `?` goes whole. A path holding `@` loses more than the credentials: it errs on
 * the side of hiding.
 */
function withoutUrlCredentials(message: string): string {
  // Index searches, not a pattern: one pass over each token, whatever the message holds.
  return message
    .split(/(\s+)/)
    .map((token) => {
      const scheme = token.indexOf('://');
      const at = token.lastIndexOf('@');

      return scheme !== -1 && at > scheme
        ? token.slice(0, scheme + 3) + token.slice(at + 1)
        : token;
    })
    .join('');
}

/**
 * Ends a chat that could not run: the failure on stderr, as `describeFailure` says it (its causes
 * too, so an unreachable backend says why), and the exit code (130 for a setup the
 * user cancelled, 1 for anything else) as the process's exit code, so the process ends by itself.
 */
export function reportChatFailure(caughtError: unknown): void {
  console.error(withoutUrlCredentials(describeFailure(caughtError)));
  process.exitCode = caughtError instanceof SetupCancelledError ? 130 : 1;
}

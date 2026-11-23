// A catch that logs and rethrows reports the same failure twice: once here, once where it is
// finally handled, with two entries for one fault and the first without the context the second
// has. The place an error ENDS logs it; every place above it throws, adding `cause` if it adds
// a message. Covers a `catch` clause and the inline function of `.catch(...)`: a log call that
// comes before a throw of the same catch (a log after a throw is another path, the handled one).
// Not covered: a log call and a rethrow in different functions of one catch, or a rethrow written
// as `return Promise.reject(error)`.

import { catchTracker, logCall } from './catch-scope.utils.js';

const MESSAGE =
  'A catch that logs also rethrows, so the failure is logged twice. Log where the error ends (the request handler, the background run) and only rethrow here, with `cause` if you add a message; or log it here and handle it (a default, a retry) without throwing.';

const PATH_ENDS = new Set(['ReturnStatement', 'ContinueStatement', 'BreakStatement']);

/**
 * Whether the statement holding the log call is followed, in its own block, by a `return`,
 * `continue` or `break`: that path leaves the catch, so a throw elsewhere (a sibling branch) is
 * never also reached (`if (known) { logger.warn(…); return fallback; } throw e;`).
 */
function endsPath(call) {
  let statement = call;

  while (statement.parent && !Array.isArray(statement.parent.body)) statement = statement.parent;

  const siblings = statement.parent?.body ?? [];
  const after = siblings.slice(siblings.indexOf(statement) + 1);

  return after.some((next) => PATH_ENDS.has(next.type));
}

export const noLogAndThrow = {
  meta: {
    type: 'problem',
    schema: [],
    messages: { logAndThrow: MESSAGE },
  },
  create(context) {
    const { sourceCode } = context;
    // Both happen only when the log comes first: a throw ends the path, so a log after it (the
    // `if (!(e instanceof Known)) throw e;` then `logger.warn(…)` shape) is the handled case.
    const tracker = catchTracker((entry) => {
      for (const call of entry.calls) {
        if (endsPath(call)) continue;

        if (entry.throws.some((at) => call.range[0] < at)) {
          context.report({ node: call, messageId: 'logAndThrow' });
        }
      }
    });

    return {
      ...tracker.visitors,
      ThrowStatement(node) {
        tracker.current()?.throws.push(node.range[0]);
      },
      CallExpression(node) {
        const entry = tracker.current();

        if (entry && logCall({ node, sourceCode })) entry.calls.push(node);
      },
    };
  },
};

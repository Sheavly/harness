// In an app that logs through `@sheavly/logger`, a failure that ends in a catch is logged with
// the logger: a line written to stderr or the console is lost when the app's output is (a UI that
// started the backend reads its stderr through `onOutput` and can drop it), carries no stack or
// conversation id, and is not in the log a person reads with `jq`. The app's logger has stderr as
// one of its sinks, so nothing is lost by using it. Enabled only for apps that depend on the
// logger (`base.js` reads that from their package.json). Not covered: output written through a
// function passed in (`log(text)`), which the logger rules cannot tell from other calls.

import { catchTracker } from './catch-scope.utils.js';

const MESSAGE =
  'Log a failure with the logger, not stderr or the console: `logger.error(LOG_EVENT.X, { error: caughtError })`. It carries the stack, the cause chain and the conversation id, goes to the log file a person reads, and stderr is one of its sinks.';

/** Whether `node` is `process.stderr.write(...)` or any `console.<method>(...)`. */
function isFailureOutput(node) {
  const { callee } = node;

  if (callee.type !== 'MemberExpression') return false;

  const { object } = callee;

  if (object.type === 'Identifier') return object.name === 'console';

  return (
    object.type === 'MemberExpression' &&
    object.object.name === 'process' &&
    object.property.name === 'stderr'
  );
}

export const noFailureOutputInCatch = {
  meta: {
    type: 'problem',
    schema: [],
    messages: { output: MESSAGE },
  },
  create(context) {
    const tracker = catchTracker(() => undefined);

    return {
      ...tracker.visitors,
      CallExpression(node) {
        if (tracker.current() && isFailureOutput(node)) {
          context.report({ node, messageId: 'output' });
        }
      },
    };
  },
};

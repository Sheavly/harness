// A `utils`, `validator` or `prompt` file is pure: it returns a value and does nothing else, so
// a test can call it with no setup. A logger is a side effect (a sink writes a file), so a pure
// file neither builds one nor calls one. It returns what the caller should log (an error, a
// field), and the caller, a helper or a service, logs it. A logger passed in and called in a
// pure file is caught as a call; a logger type only taken as a parameter is not.

import { relativePath } from './relative-path.utils.js';
import { logCall } from './catch-scope.utils.js';

const PURE_KIND = /\.(utils|validator|prompt)\.tsx?$/;
const LOGGER_FACTORY = /^@sheavly\/logger\/logger\/logger\.helper$|logger\.helper(\.js)?$/;

const MESSAGE =
  'A pure file (`*.utils.ts`, `*.validator.ts`, `*.prompt.ts`) does not log: it returns what happened and its caller, a `*.helper.ts` or `*.service.ts`, logs it. Move the logging to the caller, or the function to a helper.';

export const noLoggerInPureKind = {
  meta: {
    type: 'problem',
    schema: [],
    messages: { pure: MESSAGE },
  },
  create(context) {
    if (!PURE_KIND.test(relativePath(context))) return {};

    const { sourceCode } = context;

    return {
      ImportDeclaration(node) {
        if (node.importKind !== 'type' && LOGGER_FACTORY.test(node.source.value)) {
          context.report({ node, messageId: 'pure' });
        }
      },
      CallExpression(node) {
        if (logCall({ node, sourceCode })) context.report({ node, messageId: 'pure' });
      },
    };
  },
};

// The caught value is logged as the `error` field itself, so the entry keeps its name, stack and
// cause chain (`createLogEntry` serializes it and redacts it once). `error.message`, a template
// or `String(error)` keeps one line of text: the stack, the code and the causes are the evidence
// for tracing a failure. Not covered: the text built in a variable and passed as `error`.

import { logCall } from './catch-scope.utils.js';

const MESSAGE =
  'Log the caught value itself: `logger.error(LOG_EVENT.X, { error: caughtError })`. The logger serializes it with its stack and cause chain and redacts it; `error.message`, a template or `String(error)` keeps only text.';

// The ways this codebase made an error a line of text before the logger: the logger redacts the
// value itself (`redactDiagnosticText`), so an already redacted string is the same mistake.
const TEXT_FUNCTIONS = new Set(['String', 'errorMessage', 'redactDiagnosticText', 'printable']);
const TEXT_PROPERTIES = new Set(['message', 'stack', 'name']);

/** Whether `value` turns an error into text: `e.message`, a template, `String(e)`, `'' + e`. */
function isErrorAsText(value) {
  // `e instanceof Error ? e.message : String(e)` and `e.message ?? 'x'`: text in either branch.
  if (value.type === 'ConditionalExpression') {
    return isErrorAsText(value.consequent) || isErrorAsText(value.alternate);
  }

  if (value.type === 'LogicalExpression') {
    return isErrorAsText(value.left) || isErrorAsText(value.right);
  }

  if (value.type === 'TemplateLiteral') return true;
  if (value.type === 'BinaryExpression') return value.operator === '+';

  if (value.type === 'MemberExpression') {
    return !value.computed && TEXT_PROPERTIES.has(value.property.name);
  }

  if (value.type !== 'CallExpression') return false;

  const { callee } = value;

  return TEXT_FUNCTIONS.has(callee.name ?? callee.property?.name);
}

function isErrorProperty(property) {
  if (property.type !== 'Property' || property.computed) return false;

  return property.key.name === 'error' || property.key.value === 'error';
}

export const logErrorAsValue = {
  meta: {
    type: 'problem',
    schema: [],
    messages: { asText: MESSAGE },
  },
  create(context) {
    const { sourceCode } = context;

    return {
      CallExpression(node) {
        const call = logCall({ node, sourceCode });

        if (call?.fields?.type !== 'ObjectExpression') return;

        for (const property of call.fields.properties) {
          if (isErrorProperty(property) && isErrorAsText(property.value)) {
            context.report({ node: property.value, messageId: 'asText' });
          }
        }
      },
    };
  },
};

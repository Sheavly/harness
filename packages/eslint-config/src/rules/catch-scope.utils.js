// What the logging rules share: which node is inside a `catch` (a clause, or the inline function
// of a `.catch(...)`), and which call is a log call. A function inside a catch is its own scope,
// so a callback that throws later is not "the catch throws".

const FUNCTION_TYPES = ['FunctionDeclaration', 'FunctionExpression', 'ArrowFunctionExpression'];
const LEVELS = new Set(['debug', 'info', 'warn', 'error']);
// The receiver is named like a logger: `logger`, `log`, `logs`, `this.#logger`, `logs.server`,
// `logs.conversation(id)`, `conversationLogger`. A logger held under another name is not seen.
const LOGGER_NAME = /(^|[^A-Za-z0-9_])(log|logs|logger)([^A-Za-z0-9_]|$)|[a-z]Logger\b/;

/** `{ event, fields }` (AST nodes) when `node` is a call of a logger's level method, else null. */
export function logCall(params) {
  const { node, sourceCode } = params;
  const { callee } = node;

  if (callee.type !== 'MemberExpression' || callee.computed) return null;
  if (!LEVELS.has(callee.property.name) || node.arguments.length === 0) return null;
  if (!LOGGER_NAME.test(sourceCode.getText(callee.object))) return null;

  return { event: node.arguments[0], fields: node.arguments[1] };
}

/** Whether `fn` is the inline handler of a promise's `.catch(fn)`. */
function isCatchHandler(fn) {
  const call = fn.parent;

  return (
    call?.type === 'CallExpression' &&
    call.callee.type === 'MemberExpression' &&
    call.callee.property.name === 'catch' &&
    call.arguments[0] === fn
  );
}

/**
 * Visitors that keep a stack of the catches around the current node. `current()` is the entry of
 * the innermost scope when it is a catch (`{ node, calls: [], throws: [] }`: the log calls, and
 * the source positions of the throws, seen so far), else null; a rule
 * spreads `visitors` into its own and reads `current()` from its handlers. `onExit` is called
 * with each catch entry as its scope ends.
 */
export function catchTracker(onExit) {
  const stack = [];
  const enter = (node) => {
    stack.push({ node, calls: [], throws: [] });
  };
  const leave = () => {
    const entry = stack.pop();

    if (entry) onExit(entry);
  };
  const visitors = {
    CatchClause: enter,
    'CatchClause:exit': leave,
  };

  for (const type of FUNCTION_TYPES) {
    visitors[type] = (node) => {
      if (isCatchHandler(node)) enter(node);
      else stack.push(null);
    };

    visitors[`${type}:exit`] = leave;
  }

  return { visitors, current: () => stack.at(-1) ?? null };
}

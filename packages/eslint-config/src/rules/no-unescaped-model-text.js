// Text that someone other than the harness wrote reaches the model through `escapedLine`, or
// `escapeTags` for a body whose line breaks are content, never as it is. A task's command, a
// session's title and status, an error that quotes either, are written by a model, a tool or an
// extension (an extension names its own work and children), and a model reads a tool result or a
// notice as text it can act on: a closing tag or a line that looks like a header would pass for the
// harness's own.
//
// Type-aware. It fails a template literal piece, a `+` or `+=` operand, or an element of an array
// given to `.join(...)`, that prints a free-text field straight in, by name (`title`, `command`,
// `description`, `error`, `status`, `reason`), when the field is a plain `string` declared by a
// task, session, node, notice, approval or output type of the protocol, or by the runtime's own
// node, task or session types. It looks through what only passes the field along: an optional
// chain, `??` and `||` (either side), the right side of `&&` (its left only decides), a
// conditional (either branch), `!`, `as`, `satisfies` and a type assertion; and, for `.join`,
// through `.filter(...)`, `.flat()`, `.slice(...)` and the like to the array literal, unless the
// joined text is handed whole to a call (`escapeTags([a.error, a.output].join('\n'))`). So `${session?.title ?? id}`, `${a ? task.error : ''}` and `${task.command as string}`
// fail like `${task.command}`. A field whose type is a union of literals (`TaskInfo.status`:
// running, completed, ...) is an enum the harness chose and is allowed. A value that passed through
// a call is allowed, which is how `escapedLine(task.command)` is written; so a call that is not an
// escaper (`String(...)`, `.trim()`, `.slice(...)`) hides a field from the rule too. A tool's own
// input (`input.title`, the model's own words handed back) and a local `{ title }` are not
// declared by those types and are not touched.
//
// Not covered, and left to review and to tests that pass a closing tag and a newline through every
// place a field is printed: a field assigned to a variable or destructured first
// (`const { command } = task`), an object spread into a renderer, `JSON.stringify(task)`, a field
// read by another name or by a computed key, `String(...)`, `.concat(...)` and other methods, an
// array that is mapped before `.join` or built elsewhere, text that reaches the model by a path
// that is not a template, `+`, `+=` or `.join`, a field of a type this rule does not name (a
// skill's `description`), and developer messages are checked too (an `Error` message that prints
// such a field fails, and is fixed the same way). Tests and files under a `testing` folder are exempt through the shared
// config's `ignores`.

const MESSAGE =
  'This field is written by a model, a tool or an extension, and the model reads what is printed. Pass it through `escapedLine(...)` (`@sheavly/core/text/text.utils`: one line, no tag, no control character) before it is part of the text, or `escapeTags(...)` for a body whose line breaks are content. An enum such as `TaskInfo.status` needs neither. See "Text the model reads" in principles.md.';

const FREE_TEXT = new Set(['title', 'command', 'description', 'error', 'status', 'reason']);
/**
 * The folders whose types describe a task, a session, a node or what is said about one: the
 * protocol's, and the runtime's own record types (`NodeRecord`, `StartTask`, ...).
 */
const MODEL_TEXT_TYPES =
  /(^|\/)(protocol\/(src\/)?(task|session|node|notice|approval|output)|runtime\/src\/(nodes|tasks|sessions))\//;
/** The nodes that only pass a value along: the value inside them is what is printed. */
const PASS_THROUGH = new Set([
  'ChainExpression',
  'TSNonNullExpression',
  'TSAsExpression',
  'TSTypeAssertion',
  'TSSatisfiesExpression',
]);
/** Array methods that keep the elements as they were: the array a `.join` prints is behind them. */
const KEEPS_ELEMENTS = new Set(['filter', 'flat', 'slice', 'toSorted', 'toReversed', 'reverse']);

/** The text of a plain `.name` (not a computed key) a member expression reads, or null. */
function propertyName(member) {
  if (member.computed) return null;

  return member.property.type === 'Identifier' ? member.property.name : null;
}

/** True if `type` is a plain string, not a literal or a union of literals the harness chose. */
function isPlainString(params) {
  const { type, checker } = params;
  const present = checker.getNonNullableType(type);

  if (present.isUnion()) {
    return present.types.every((part) => isPlainString({ type: part, checker }));
  }

  // By the compiler's own name for it, not a `TypeFlags` number: `string`, never a literal.
  return checker.typeToString(present) === 'string';
}

/** True if the property `name` of `type` is declared by one of the folders in `MODEL_TEXT_TYPES`. */
function isModelTextField(params) {
  const { type, name, checker } = params;
  const apparent = checker.getApparentType(checker.getNonNullableType(type));
  const parts = apparent.isUnionOrIntersection() ? apparent.types : [apparent];

  return parts.some((part) =>
    (part.getProperty(name)?.declarations ?? []).some((declaration) =>
      MODEL_TEXT_TYPES.test(declaration.getSourceFile().fileName),
    ),
  );
}

/** The member reads `node` prints as they are: through what only passes a value along. */
function printedMembers(node) {
  if (PASS_THROUGH.has(node.type)) return printedMembers(node.expression);

  if (node.type === 'LogicalExpression') {
    // `a && b` prints `b`: its left side only decides, and is falsy when it prints at all.
    return node.operator === '&&'
      ? printedMembers(node.right)
      : [...printedMembers(node.left), ...printedMembers(node.right)];
  }

  if (node.type === 'ConditionalExpression') {
    return [...printedMembers(node.consequent), ...printedMembers(node.alternate)];
  }

  return node.type === 'MemberExpression' ? [node] : [];
}

/** The array literal a `.join` prints, through `.filter(...)` and the like, or null if it is not one. */
function joinedArray(node) {
  let current = node;

  while (
    current.type === 'CallExpression' &&
    current.callee.type === 'MemberExpression' &&
    KEEPS_ELEMENTS.has(propertyName(current.callee) ?? '')
  ) {
    current = current.callee.object;
  }

  return current.type === 'ArrayExpression' ? current : null;
}

export const noUnescapedModelText = {
  meta: { type: 'problem', schema: [], messages: { unescaped: MESSAGE } },
  create(context) {
    const services = context.sourceCode.parserServices;

    // Without type information (plain JS) there is no type to check.
    if (!services?.program) return {};

    const checker = services.program.getTypeChecker();
    const typeOf = (node) => checker.getTypeAtLocation(services.esTreeNodeToTSNodeMap.get(node));

    /** Reports each member `node` prints that is a free-text field of the types above. */
    function check(node) {
      for (const member of printedMembers(node)) {
        const name = propertyName(member);

        if (name === null || !FREE_TEXT.has(name)) continue;

        if (!isModelTextField({ type: typeOf(member.object), name, checker })) continue;

        if (isPlainString({ type: typeOf(member), checker })) {
          context.report({ node: member, messageId: 'unescaped' });
        }
      }
    }

    return {
      TemplateLiteral(node) {
        for (const expression of node.expressions) check(expression);
      },
      BinaryExpression(node) {
        if (node.operator !== '+') return;

        check(node.left);
        check(node.right);
      },
      AssignmentExpression(node) {
        if (node.operator === '+=') check(node.right);
      },
      CallExpression(node) {
        const callee = node.callee;
        const isJoin = callee.type === 'MemberExpression' && propertyName(callee) === 'join';

        if (!isJoin) return;

        // `escapeTags([a.error, a.output].join('\n'))`: the whole joined text goes through a call,
        // which is the boundary, so its elements are not printed raw.
        const parent = node.parent;

        if (parent?.type === 'CallExpression' && parent.arguments.includes(node)) return;

        const array = joinedArray(callee.object);

        if (array === null) return;

        for (const element of array.elements) {
          if (element !== null && element.type !== 'SpreadElement') check(element);
        }
      },
    };
  },
};

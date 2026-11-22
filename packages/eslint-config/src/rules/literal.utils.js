/**
 * The text of a string literal or an expression-free template, else undefined (a computed path).
 * Every rule that reads a module specifier uses this, so `` import(`x`) `` is checked like `'x'`
 * everywhere.
 */
export function literalText(node) {
  if (node?.type === 'Literal' && typeof node.value === 'string') return node.value;

  if (node?.type === 'TemplateLiteral' && node.expressions.length === 0) {
    return node.quasis[0].value.cooked ?? undefined;
  }

  return undefined;
}

/**
 * The text a specifier is known to start with, even when the rest is computed: a literal's whole
 * text, a template's first piece, or the start of a `+` chain. For a rule about a module prefix,
 * where `'prefix/' + name` reaches the same modules as `'prefix/name'`.
 */
export function leadingText(node) {
  if (node?.type === 'TemplateLiteral') return node.quasis[0].value.cooked ?? undefined;

  if (node?.type === 'BinaryExpression' && node.operator === '+') return leadingText(node.left);

  return literalText(node);
}
